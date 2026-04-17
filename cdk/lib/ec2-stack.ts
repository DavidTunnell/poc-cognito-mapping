import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface Ec2StackProps extends cdk.StackProps {
  bucketA: s3.Bucket;
  bucketB: s3.Bucket;
  bucketC: s3.Bucket;
  deployBucket: s3.Bucket;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
}

export class Ec2Stack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: Ec2StackProps) {
    super(scope, id, props);

    // This branch (opensearch-extension) moves the POC EC2 into the CloudSeeDrive-UAT
    // VPC so the app can reach the UAT OpenSearch VPC endpoint directly. The alternative
    // (editing Test VPC route tables to use the existing UAT<->Test peering) touches
    // shared infra that other workloads depend on; running in UAT's public subnet is a
    // net-new EC2 that teardown removes cleanly.
    //
    // Baseline POC (main branch) defaults were: vpc-0c27f04a8a26fcad3 / subnet-06d30247b5d487c64.
    // Override either set via context: `cdk deploy -c vpcId=... -c subnetId=... -c az=...`
    const vpcId = (this.node.tryGetContext('vpcId') as string) ?? 'vpc-0e4dc9327a601ac89';
    const subnetId = (this.node.tryGetContext('subnetId') as string) ?? 'subnet-0b06f0e8a3cf4082c';
    const az = (this.node.tryGetContext('az') as string) ?? 'us-east-1a';

    // UAT OpenSearch domain — app reaches it over the VPC endpoint.
    const opensearchDomainName = 'cloudseedrive-uat';
    const opensearchEndpoint = 'vpc-cloudseedrive-uat-bmfr4znnqgl5fq2gf2qjn6xsbu.us-east-1.es.amazonaws.com';
    const opensearchIndex = 'poc-csd-objects';

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId,
      availabilityZones: [az],
      publicSubnetIds: [subnetId],
    });

    const sg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc,
      description: 'POC CSD app - HTTP in from anywhere',
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Read the deploy tarball
    props.deployBucket.grantRead(role);

    // Custom-mode: broad S3 RW on the three demo buckets
    for (const b of [props.bucketA, props.bucketB, props.bucketC]) {
      b.grantReadWrite(role);
    }

    // OpenSearch access. Note: granting es:ESHttp* here is necessary but NOT sufficient —
    // the UAT domain has a resource-based access policy that must also include this role
    // ARN, and FGAC requires a backend role mapping. Both are applied by
    // scripts/bootstrap-opensearch.sh using the master user's credentials.
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['es:ESHttpGet', 'es:ESHttpPost', 'es:ESHttpPut', 'es:ESHttpDelete', 'es:ESHttpHead'],
      resources: [
        `arn:aws:es:${this.region}:${this.account}:domain/${opensearchDomainName}`,
        `arn:aws:es:${this.region}:${this.account}:domain/${opensearchDomainName}/*`,
      ],
    }));

    // Cognito admin ops — listing users/groups for the admin UI
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:ListUsers',
        'cognito-idp:ListGroups',
        'cognito-idp:ListUsersInGroup',
        'cognito-idp:AdminGetUser',
        'cognito-idp:InitiateAuth',
        'cognito-idp:AdminInitiateAuth',
      ],
      resources: [
        `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.userPoolId}`,
      ],
    }));

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -e',
      'dnf update -y',
      'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -',
      'dnf install -y nodejs',
      'mkdir -p /opt/app',
      'chown ec2-user:ec2-user /opt/app',
      // Deploy helper invoked by SSM send-command
      'cat > /usr/local/bin/poc-csd-deploy <<\'DEPLOYEOF\'',
      '#!/bin/bash',
      'set -e',
      `aws s3 cp s3://${props.deployBucket.bucketName}/app.tar.gz /tmp/app.tar.gz`,
      'rm -rf /opt/app/current.new',
      'mkdir -p /opt/app/current.new',
      'tar xzf /tmp/app.tar.gz -C /opt/app/current.new',
      'rm -rf /opt/app/previous',
      '[ -d /opt/app/current ] && mv /opt/app/current /opt/app/previous || true',
      'mv /opt/app/current.new /opt/app/current',
      'chown -R ec2-user:ec2-user /opt/app/current',
      'cd /opt/app/current/server && /usr/bin/npm install --omit=dev --no-audit --no-fund',
      'systemctl restart poc-csd',
      'DEPLOYEOF',
      'chmod +x /usr/local/bin/poc-csd-deploy',
      // systemd unit
      'cat > /etc/systemd/system/poc-csd.service <<\'SVCEOF\'',
      '[Unit]',
      'Description=POC CSD Server',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'User=ec2-user',
      'WorkingDirectory=/opt/app/current/server',
      'ExecStart=/usr/bin/node dist/index.js',
      'Restart=on-failure',
      'RestartSec=5',
      'Environment=NODE_ENV=production',
      'Environment=PORT=80',
      `Environment=USER_POOL_ID=${props.userPoolId}`,
      `Environment=USER_POOL_CLIENT_ID=${props.userPoolClientId}`,
      `Environment=IDENTITY_POOL_ID=${props.identityPoolId}`,
      `Environment=AWS_REGION=${this.region}`,
      `Environment=BUCKET_A=${props.bucketA.bucketName}`,
      `Environment=BUCKET_B=${props.bucketB.bucketName}`,
      `Environment=BUCKET_C=${props.bucketC.bucketName}`,
      `Environment=DEPLOY_BUCKET=${props.deployBucket.bucketName}`,
      `Environment=OPENSEARCH_ENDPOINT=${opensearchEndpoint}`,
      `Environment=OPENSEARCH_INDEX=${opensearchIndex}`,
      'AmbientCapabilities=CAP_NET_BIND_SERVICE',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SVCEOF',
      'systemctl daemon-reload',
      'systemctl enable poc-csd',
      // service won't start cleanly until an app is deployed — that's fine
      'systemctl start poc-csd || true',
    );

    this.instance = new ec2.Instance(this, 'AppInstance', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: sg,
      role,
      userData,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // Test-VPC public subnet has MapPublicIpOnLaunch=false, so force assignment.
      associatePublicIpAddress: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(8, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
      }],
    });
    cdk.Tags.of(this.instance).add('Role', 'poc-csd-app');
    cdk.Tags.of(this.instance).add('Name', 'poc-csd-app');

    new cdk.CfnOutput(this, 'InstancePublicIp', { value: this.instance.instancePublicIp });
    new cdk.CfnOutput(this, 'InstancePublicDnsName', { value: this.instance.instancePublicDnsName });
    new cdk.CfnOutput(this, 'InstanceId', { value: this.instance.instanceId });
    new cdk.CfnOutput(this, 'InstanceRoleArn', { value: role.roleArn });
    new cdk.CfnOutput(this, 'AppUrl', { value: `http://${this.instance.instancePublicDnsName}` });
    new cdk.CfnOutput(this, 'OpensearchEndpoint', { value: opensearchEndpoint });
    new cdk.CfnOutput(this, 'OpensearchIndex', { value: opensearchIndex });
    new cdk.CfnOutput(this, 'OpensearchDomainName', { value: opensearchDomainName });
  }
}
