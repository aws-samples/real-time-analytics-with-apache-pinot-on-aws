import * as cdk from 'aws-cdk-lib';
import {RemovalPolicy} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {EbsDeviceVolumeType, SubnetType} from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as S3Deployment from "aws-cdk-lib/aws-s3-deployment";
import {readFileSync} from "fs";
import * as iam from "aws-cdk-lib/aws-iam"
import {ManagedPolicy} from "aws-cdk-lib/aws-iam"
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as kinesis from "aws-cdk-lib/aws-kinesis"
import {StreamMode} from "aws-cdk-lib/aws-kinesis"
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as hooks from 'aws-cdk-lib/aws-autoscaling-hooktargets';
import { NagSuppressions } from 'cdk-nag';
import * as kms from 'aws-cdk-lib/aws-kms';
import path = require('path');

export class ApachePinotSolutionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Define a parameter for the IP address
    const ipAddressParam = new cdk.CfnParameter(this, 'IpAddress', {
      type: 'String',      
      description: 'The IP address to associate with the resource'
    });

    const ipAddress = ipAddressParam.valueAsString;
    if (!ipAddress || ipAddress === '') {
      throw new Error('IpAddress parameter is required');
    }
    //create a keypair

    const paddedKeyPairName: string = `pinot-stack-keypair-${Math.floor(100000 + Math.random() * 900000)}`;
    const keyPair = new ec2.CfnKeyPair(this, 'KeyPair', {
      keyName: paddedKeyPairName,      
    });
    
    


    // VPC
    const vpc = new ec2.Vpc(this, 'VPC', {
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 3,
      natGateways: 3,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public-subnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private-subnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3
        }
      }
    });

    NagSuppressions.addResourceSuppressions(vpc, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'vpc flow logs not enabled for cost reasons'
      },
    ]);

    const s3Bucket = new s3.Bucket(this, 'Bucket', {
      bucketName : 'apache-pinot-solution-'+this.account + '-' + this.region,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    NagSuppressions.addResourceSuppressions(s3Bucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'server access logging disabled for cost reasons'
      },
    ]);

    const zookeeperScript = new S3Deployment.BucketDeployment(this, "ZookeeperInstallationScript", {
      sources: [S3Deployment.Source.asset('./resources/zookeeper')],
      destinationBucket: s3Bucket,
      destinationKeyPrefix: 'scripts/zookeeper'
    })


    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource`,
      [{ 
        id: 'AwsSolutions-L1', 
        reason: 'lambda version not controllable from S3Deployment' 
      }]
    );


    //security group for MSK access
    const ec2SG = new ec2.SecurityGroup(this, 'ec2SG', {
      vpc: vpc,
      allowAllOutbound: true,
      description: 'ec2 Security Group'
    });

    ec2SG.connections.allowInternally(ec2.Port.allTraffic(), 'Allow all traffic between hosts having the same security group');
    

    const ec2Role = new iam.Role(this, 'EC2 Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'), ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2FullAccess'),ManagedPolicy.fromAwsManagedPolicyName('AmazonKinesisFullAccess'),ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedEC2InstanceDefaultPolicy')],
    });

         
    const zookeeperNode1 = new ec2.Instance(this, 'zookeeperNode1', {
      vpc: vpc,
      role:  ec2Role,
      keyName: keyPair.ref,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.SMALL),
      machineImage: new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      securityGroup: ec2SG,
      userDataCausesReplacement: true,
      detailedMonitoring: true,
    });



    const cfnInsZookeeper1 = zookeeperNode1.node.defaultChild as ec2.CfnInstance;
    cfnInsZookeeper1.addPropertyOverride('DisableApiTermination', true);

		NagSuppressions.addResourceSuppressions(
			zookeeperNode1,
			[				
				{
					id: 'AwsSolutions-EC29',
					reason: 'Remediated through property override.',
				},
			],
			true
		);

    let userDataScriptNode1 = readFileSync('./resources/zookeeper/userdata-node1.sh','utf8')
    userDataScriptNode1 = userDataScriptNode1.replaceAll('${S3BucketName}',s3Bucket.bucketName)
    userDataScriptNode1 = userDataScriptNode1.replaceAll('${AWS::Region}',this.region)
    userDataScriptNode1 = userDataScriptNode1.replaceAll('${RootStackName}',this.stackName)
    userDataScriptNode1 = userDataScriptNode1.replaceAll('${ZookeeperNodeCount}','3')
    userDataScriptNode1 = userDataScriptNode1.replaceAll('${ZookeeperVersion}','3.5.10')
    zookeeperNode1.addUserData(userDataScriptNode1);

    const zookeeperNode2 = new ec2.Instance(this, 'zookeeperNode2', {
      vpc: vpc,
      role:  ec2Role,
      keyName: keyPair.ref,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.SMALL),
      machineImage: new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      securityGroup: ec2SG,
      userDataCausesReplacement: true,
      detailedMonitoring: true,
    });

    
    const cfnInsZookeeper2 = zookeeperNode2.node.defaultChild as ec2.CfnInstance;
    cfnInsZookeeper2.addPropertyOverride('DisableApiTermination', true);
    NagSuppressions.addResourceSuppressions(zookeeperNode2, [
      {
        id: 'AwsSolutions-EC29',
        reason: 'Remediated through property override.',
      },
    ]);


    let userDataScriptNode2 = readFileSync('./resources/zookeeper/userdata-node2.sh','utf8')
    userDataScriptNode2 = userDataScriptNode2.replaceAll('${S3BucketName}',s3Bucket.bucketName)
    userDataScriptNode2 = userDataScriptNode2.replaceAll('${AWS::Region}',this.region)
    userDataScriptNode2 = userDataScriptNode2.replaceAll('${RootStackName}',this.stackName)
    userDataScriptNode2 = userDataScriptNode2.replaceAll('${ZookeeperNodeCount}','3')
    userDataScriptNode2 = userDataScriptNode2.replaceAll('${ZookeeperVersion}','3.5.10')
    zookeeperNode2.addUserData(userDataScriptNode2);

    const zookeeperNode3 = new ec2.Instance(this, 'zookeeperNode3', {
      vpc: vpc,
      role:  ec2Role,
      keyName: keyPair.ref,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.SMALL),
      machineImage: new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      securityGroup: ec2SG,
      userDataCausesReplacement: true,
      detailedMonitoring: true,
    });


    const cfnInsZookeeper3 = zookeeperNode3.node.defaultChild as ec2.CfnInstance;
    cfnInsZookeeper3.addPropertyOverride('DisableApiTermination', true);
    NagSuppressions.addResourceSuppressions(zookeeperNode3, [
      {
        id: 'AwsSolutions-EC29',
        reason: 'Remediated through property override.',
      },
    ]);

    let userDataScriptNode3 = readFileSync('./resources/zookeeper/userdata-node3.sh','utf8')
    userDataScriptNode3 = userDataScriptNode3.replaceAll('${S3BucketName}',s3Bucket.bucketName)
    userDataScriptNode3 = userDataScriptNode3.replaceAll('${AWS::Region}',this.region)
    userDataScriptNode3 = userDataScriptNode3.replaceAll('${RootStackName}',this.stackName)
    userDataScriptNode3 = userDataScriptNode3.replaceAll('${ZookeeperNodeCount}','3')
    userDataScriptNode3 = userDataScriptNode3.replaceAll('${ZookeeperVersion}','3.5.10')
    zookeeperNode3.addUserData(userDataScriptNode3);

    const pinotControllerConfDeployment = new S3Deployment.BucketDeployment(this, "PinotControlConfDeployment", {
      sources: [S3Deployment.Source.asset('./resources/pinot/conf/controller')],
      destinationBucket: s3Bucket,
      destinationKeyPrefix: 'resources/pinot/conf/controller'
    });

    pinotControllerConfDeployment.node.addDependency(zookeeperNode3)


    //sec group for LB
    const securityGroup1 = new ec2.SecurityGroup(this, 'SecurityGroup-Load-Balancer', { vpc });      
    securityGroup1.addIngressRule(
      ec2.Peer.ipv4(ipAddress),
      ec2.Port.tcp(80),
      'allow HTTP traffic from specific ip address',
    );

    //add bastion host's SG as ingress
    securityGroup1.addIngressRule(
      ec2SG,
      ec2.Port.tcp(80),
      'allow HTTP traffic from bastion host',
    );

    const controllerLoadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ControllerApplicationLoadBalancer', {
      vpc,
      internetFacing: true,      
      securityGroup: securityGroup1,
    });
    
  
    new cdk.CfnOutput(this, 'ControllerDNSUrl', { value: controllerLoadBalancer.loadBalancerDnsName });

    
    NagSuppressions.addResourceSuppressions(controllerLoadBalancer, [
      {
        id: 'AwsSolutions-ELB2',
        reason: 'elb access log not enabled for cost reasons'
      },
    ])

    let pinotControllerUserData = readFileSync('./resources/pinot/userData/userdata-pinotcontroller.sh','utf8')
    pinotControllerUserData = pinotControllerUserData.replaceAll('${S3BucketName}',s3Bucket.bucketName)
    pinotControllerUserData = pinotControllerUserData.replaceAll('${AWS::Region}',this.region)
    pinotControllerUserData = pinotControllerUserData.replaceAll('{$LoadBalancerDNS}',controllerLoadBalancer.loadBalancerDnsName)


    const pinotControllerLaunchTemplate = new ec2.LaunchTemplate(this, 'pinotControllerLaunchTemplate', {
      machineImage: new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      keyName: keyPair.ref,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5,ec2.InstanceSize.LARGE),
      securityGroup: ec2SG,
      role: ec2Role,
      blockDevices: [
          {deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(300,{
            volumeType: EbsDeviceVolumeType.GP3,
            encrypted: true,
          })
          }
      ]
    });

    pinotControllerLaunchTemplate.node.addDependency(zookeeperNode3)
    pinotControllerLaunchTemplate.node.addDependency(pinotControllerConfDeployment)

    const pinotControllerAutoscalingGroup = new autoscaling.AutoScalingGroup(this, 'PinotController ASG', {
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      },
      autoScalingGroupName: 'PinotControllerASG',
      desiredCapacity: 1,
      maxCapacity: 2,
      minCapacity: 1,
      healthCheck: autoscaling.HealthCheck.ec2(),
      launchTemplate: pinotControllerLaunchTemplate,
    });


    NagSuppressions.addResourceSuppressions(pinotControllerAutoscalingGroup, [
      {
        id: 'AwsSolutions-AS3',
        reason: 'auto scaling notification is done via Lambda/SQS'
      },
    ]);


    pinotControllerAutoscalingGroup.addUserData(pinotControllerUserData);

    pinotControllerAutoscalingGroup.scaleOnCpuUtilization('KeepSpareCPU', {
      targetUtilizationPercent: 50
    });

    pinotControllerAutoscalingGroup.node.addDependency(pinotControllerLaunchTemplate)
    pinotControllerAutoscalingGroup.node.addDependency(zookeeperNode3);



    const controllerListener = controllerLoadBalancer.addListener('ALBListenerBroker', {
      protocol: elbv2.ApplicationProtocol.HTTP,
      port:80,
      open: false
    });

    controllerListener.addTargets('ControllerTargetGroup', {
      port: 9000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [pinotControllerAutoscalingGroup],
    });

    const pinotServerLaunchTemplate = new ec2.LaunchTemplate(this, 'pinotServerLaunchTemplate', {
      machineImage: new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      keyName: keyPair.ref,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.R5,ec2.InstanceSize.XLARGE),
      securityGroup: ec2SG,
      role: ec2Role,
      blockDevices: [
        {deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(300,{
            volumeType: EbsDeviceVolumeType.GP3,
            encrypted: true
          })
        }
      ]
    });

    const pinotServerConfDeployment = new S3Deployment.BucketDeployment(this, "pinotServerConfDeployment", {
      sources: [S3Deployment.Source.asset('./resources/pinot/conf/server')],
      destinationBucket: s3Bucket,
      destinationKeyPrefix: 'resources/pinot/conf/server'
    });

    const pinotServerAutoscalingGroup = new autoscaling.AutoScalingGroup(this, 'PinotServer ASG', {
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC
      },
      autoScalingGroupName: 'PinotServerASG',
      desiredCapacity: 2,
      maxCapacity: 3,
      minCapacity: 2,
      healthCheck: autoscaling.HealthCheck.ec2(),
      launchTemplate: pinotServerLaunchTemplate,        
    });


    NagSuppressions.addResourceSuppressions(pinotServerAutoscalingGroup, [
      {
        id: 'AwsSolutions-AS3',
        reason: 'auto scaling notification is done via Lambda/SQS'
      },
    ]);

    let pinotServerUserData = readFileSync('./resources/pinot/userData/userdata-pinotserver.sh','utf8');
    pinotServerUserData = pinotServerUserData.replaceAll('${S3BucketName}',s3Bucket.bucketName);
    pinotServerUserData = pinotServerUserData.replaceAll('${AWS::Region}',this.region);

    pinotServerAutoscalingGroup.scaleOnCpuUtilization('KeepSpareCPU', {
      targetUtilizationPercent: 50
    });

    pinotServerAutoscalingGroup.addUserData(pinotServerUserData);

    pinotServerAutoscalingGroup.node.addDependency(pinotControllerAutoscalingGroup);

    const ServerRebalanceLambda = new lambda.SingletonFunction(this, 'ServerRebalance', {
      uuid: '97e4f730-4ee1-11e8-3c2d-fa7ae01b6eba',
      code: lambda.Code.fromInline(`
import json
import boto3
import urllib3
import time
import os
from urllib.parse import urlencode

ec2 = boto3.client('ec2')
autoscaling = boto3.client('autoscaling')
http = urllib3.PoolManager()

def remove_tags(pinotServer,controller):
    baseURL="http://"+controller+"/instances/"+pinotServer+"/updateTags?tags=&updateBrokerResource=false"
    response = http.request("PUT",baseURL)
    #response = requests.put(baseURL)


def list_tables(controller):
    baseURL="http://"+controller+"/tables"
    response = http.request("GET",baseURL)
    #response=requests.get(baseURL)
    tableList = json.loads(response.data)
    print(tableList)
    return tableList["tables"]

def rebalance_table(table,controller):
    params = {
        'type': 'realtime',
        'dryRun': 'false',
        'reassignInstances': 'true',
        'includeConsuming': 'true',
        'bootstrap': 'false',
        'downtime': 'true',
        'minAvailableReplicas': '1',
        'bestEfforts': 'true',
        'externalViewCheckIntervalInMs': '1000',
        'externalViewStabilizationTimeoutInMs': '3600000',
        'updateTargetTier': 'false',
    }
    encoded_args=urlencode(params)
    baseURL="http://"+controller+"/tables/"+table+"/rebalance/?"+encoded_args
    print(baseURL)
    response = http.request("POST",baseURL)
    print(json.loads(response.data))
    #response = requests.post(baseURL, params=params)

def check_rebalance_status(controller,table,pinotServer):
    baseURL="http://"+controller+"/segments/"+table+"/servers"
    print(baseURL)
    response = http.request("GET",baseURL)
    #response = requests.get(baseURL)
    server_to_segment_map = json.loads(response.data)[0]["serverToSegmentsMap"]
    serverList=list(server_to_segment_map.keys())
    print(serverList)
    while (pinotServer in serverList):
        print("Still rebalancing: "+ table)
        print("Sleeping 10 seconds")
        time.sleep(10)
        #response = requests.get(baseURL)
        response = http.request("GET",baseURL)
        server_to_segment_map = json.loads(response.data)[0]["serverToSegmentsMap"]
        serverList=list(server_to_segment_map.keys())
        print(serverList)
    print("Rebalance completed")   

def delete_instance(controller,pinotServer):
    baseURL="http://"+controller+"/instances/"+pinotServer
    print(baseURL)
    response = http.request("DELETE",baseURL)
    #response = requests.delete(baseURL)
    print(json.loads(response.data))

def rebalance_all(controller,pinotServer):
    remove_tags(pinotServer,controller)
    tableList = list_tables(controller)
    for table in tableList:
        rebalance_table(table,controller)
    for table in tableList:
        check_rebalance_status(controller,table,pinotServer)
    delete_instance(controller,pinotServer)


def handler(event, context):
    print(event)
    instanceID=json.loads(event['Records'][0]['Sns']['Message'])['EC2InstanceId']
    autoscalingGroupName = json.loads(event['Records'][0]['Sns']['Message'])['AutoScalingGroupName']
    lifecycleActionToken = json.loads(event['Records'][0]['Sns']['Message'])['LifecycleActionToken']
    lifecycleHookName = json.loads(event['Records'][0]['Sns']['Message'])['LifecycleHookName']
    ipAddress=ec2.describe_instances(InstanceIds=[instanceID])['Reservations'][0]['Instances'][0]['PrivateIpAddress']
    trigger = autoscaling.complete_lifecycle_action(LifecycleHookName=lifecycleHookName,AutoScalingGroupName=autoscalingGroupName,LifecycleActionToken=lifecycleActionToken,InstanceId=instanceID,LifecycleActionResult='CONTINUE')
    controller=os.environ['controller']
    pinotServer="Server_"+ipAddress+"_8098"
    time.sleep(30)
    rebalance_all(controller,pinotServer)
    print('Scale In Finished')
    `),
      handler: "index.handler",
      initialPolicy: [
        new iam.PolicyStatement(
            {
              actions: [
                "ec2:*","autoscaling:*"],
              resources: ['*']
            })
      ],
      timeout: cdk.Duration.seconds(900),
      runtime: lambda.Runtime.PYTHON_3_10,
      memorySize: 256,
      environment: {
        controller: controllerLoadBalancer.loadBalancerDnsName
      },

    });


    NagSuppressions.addResourceSuppressions(ServerRebalanceLambda, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'use ec2 and autoscaling policies'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'python 3_10 is the last version tested'
      },
      
    ]);

    const keyAlias = kms.Alias.fromAliasName(this, 'defaultKey', 'alias/aws/sns');    
    const functionHook = new hooks.FunctionHook(ServerRebalanceLambda,  keyAlias);

    const lifecycleHookServer = new autoscaling.LifecycleHook(this, "Server AutoScaling", {
      autoScalingGroup: pinotServerAutoscalingGroup,
      heartbeatTimeout: cdk.Duration.minutes(30),
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      defaultResult: autoscaling.DefaultResult.CONTINUE,
      notificationTarget: functionHook
           
    })

    const ServerAddedRebalanceLambda = new lambda.SingletonFunction(this, 'ServerAddedRebalance', {
      uuid: '97e4f730-4ee1-11e8-3c2d-fa7ae01b6etg',
      code: lambda.Code.fromInline(`
import json
import boto3
import urllib3
import time
import os
from urllib.parse import urlencode

ec2 = boto3.client('ec2')
autoscaling = boto3.client('autoscaling')
http = urllib3.PoolManager()

def list_tables(controller):
    baseURL="http://"+controller+"/tables"
    response = http.request("GET",baseURL)
    #response=requests.get(baseURL)
    tableList = json.loads(response.data)
    print(tableList)
    return tableList["tables"]

def rebalance_table(table,controller):
    params = {
        'type': 'realtime',
        'dryRun': 'false',
        'reassignInstances': 'true',
        'includeConsuming': 'true',
        'bootstrap': 'false',
        'downtime': 'true',
        'minAvailableReplicas': '1',
        'bestEfforts': 'true',
        'externalViewCheckIntervalInMs': '1000',
        'externalViewStabilizationTimeoutInMs': '3600000',
        'updateTargetTier': 'false',
    }
    encoded_args=urlencode(params)
    baseURL="http://"+controller+"/tables/"+table+"/rebalance/?"+encoded_args
    print(baseURL)
    response = http.request("POST",baseURL)
    print(json.loads(response.data))
    #response = requests.post(baseURL, params=params)

def check_rebalance_status(controller,table,pinotServer):
    baseURL="http://"+controller+"/segments/"+table+"/servers"
    print(baseURL)
    response = http.request("GET",baseURL)
    #response = requests.get(baseURL)
    server_to_segment_map = json.loads(response.data)[0]["serverToSegmentsMap"]
    serverList=list(server_to_segment_map.keys())
    print(serverList)
    while (pinotServer not in serverList):
        print("Still rebalancing: "+ table)
        print("Sleeping 10 seconds")
        time.sleep(10)
        #response = requests.get(baseURL)
        response = http.request("GET",baseURL)
        server_to_segment_map = json.loads(response.data)[0]["serverToSegmentsMap"]
        serverList=list(server_to_segment_map.keys())
        print(serverList)
    print("Rebalance completed")   

def rebalance_all(controller,pinotServer):
    tableList = list_tables(controller)
    for table in tableList:
        rebalance_table(table,controller)
    for table in tableList:
        check_rebalance_status(controller,table,pinotServer)

def handler(event, context):
    print(event)
    instanceID=json.loads(event['Records'][0]['Sns']['Message'])['EC2InstanceId']
    autoscalingGroupName = json.loads(event['Records'][0]['Sns']['Message'])['AutoScalingGroupName']
    lifecycleActionToken = json.loads(event['Records'][0]['Sns']['Message'])['LifecycleActionToken']
    lifecycleHookName = json.loads(event['Records'][0]['Sns']['Message'])['LifecycleHookName']
    ipAddress=ec2.describe_instances(InstanceIds=[instanceID])['Reservations'][0]['Instances'][0]['PrivateIpAddress']
    trigger = autoscaling.complete_lifecycle_action(LifecycleHookName=lifecycleHookName,AutoScalingGroupName=autoscalingGroupName,LifecycleActionToken=lifecycleActionToken,InstanceId=instanceID,LifecycleActionResult='CONTINUE')
    controller=os.environ['controller']
    pinotServer="Server_"+ipAddress+"_8098"
    time.sleep(100)
    rebalance_all(controller,pinotServer)
    print('Scale Out Finished')
    `),
      handler: "index.handler",
      initialPolicy: [
        new iam.PolicyStatement(
            {
              actions: [
                "ec2:*","autoscaling:*"],
              resources: ['*']
            })
      ],
      timeout: cdk.Duration.seconds(900),
      runtime: lambda.Runtime.PYTHON_3_10,
      memorySize: 256,
      environment: {
        controller: controllerLoadBalancer.loadBalancerDnsName
      },

    });

    NagSuppressions.addResourceSuppressions(ServerAddedRebalanceLambda, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'use ec2 and autoscaling policies'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'python 3_10 is the last version tested'
      },
      
    ]);

    
    const functionHookScaleout = new hooks.FunctionHook(ServerAddedRebalanceLambda,  keyAlias);
    const lifecycleHookServerScaleOut = new autoscaling.LifecycleHook(this, "Server AutoScaling Out", {
      autoScalingGroup: pinotServerAutoscalingGroup,
      heartbeatTimeout: cdk.Duration.minutes(30),
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_LAUNCHING,
      defaultResult: autoscaling.DefaultResult.CONTINUE,
      notificationTarget: functionHookScaleout
    })

    const pinotBrokerLaunchTemplate = new ec2.LaunchTemplate(this, 'pinotBrokerLaunchTemplate', {
      machineImage: new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      keyName: keyPair.ref,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5,ec2.InstanceSize.LARGE),
      securityGroup: ec2SG,
      role: ec2Role,
    });

    const pinotBrokerAutoscalingGroup = new autoscaling.AutoScalingGroup(this, 'PinotBroker ASG', {
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      },
      autoScalingGroupName: 'PinotBrokerASG',
      desiredCapacity: 1,
      maxCapacity: 2,
      minCapacity: 1,
      healthCheck: autoscaling.HealthCheck.ec2(),
      launchTemplate: pinotBrokerLaunchTemplate
    });

    NagSuppressions.addResourceSuppressions(pinotBrokerAutoscalingGroup, [
      {
        id: 'AwsSolutions-AS3',
        reason: 'auto scaling notification is done via Lambda/SQS'
      },
    ]);

    let pinotBrokerUserData = readFileSync('./resources/pinot/userData/userdata-pinotbroker.sh','utf8')
    pinotBrokerUserData = pinotBrokerUserData.replaceAll('${AWS::Region}',this.region)

    pinotBrokerAutoscalingGroup.scaleOnCpuUtilization('KeepSpareCPU', {
      targetUtilizationPercent: 50
    });

    pinotBrokerAutoscalingGroup.addUserData(pinotBrokerUserData);
    pinotBrokerAutoscalingGroup.node.addDependency(pinotControllerAutoscalingGroup)

    const brokerLoadBalancer = new elbv2.ApplicationLoadBalancer(this, 'BrokerApplicationLoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: securityGroup1,
    });

    new cdk.CfnOutput(this, 'BrokerDNSUrl', { value: brokerLoadBalancer.loadBalancerDnsName });

    NagSuppressions.addResourceSuppressions(brokerLoadBalancer, [
      {
        id: 'AwsSolutions-ELB2',
        reason: 'elb access log not enabled for cost reasons'
      },
    ])

    const brokerListener = brokerLoadBalancer.addListener('ALBListenerBroker', {
      protocol: elbv2.ApplicationProtocol.HTTP,
      port:80,
      open: false,

    });

    brokerListener.addTargets('TargetGroup', {
      port: 8099,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [pinotBrokerAutoscalingGroup],
      healthCheck: {
        path: "/query/sql",       
      }
    });

    const pinotKinesiStream = new kinesis.Stream(this, 'PinotKinesisStream', {
      streamName: "pinot-stream",
      streamMode: StreamMode.PROVISIONED,
      shardCount: 2
    });

    const bastionResourcesDeployment = new S3Deployment.BucketDeployment(this, "PinotTableResources", {
      sources: [S3Deployment.Source.asset('./resources/pinot/resources')],
      destinationBucket: s3Bucket,
      destinationKeyPrefix: 'resources/pinot/resources'
    })

    const bastionHost = new ec2.Instance(this, 'bastionHost', {
      vpc: vpc,
      role:  ec2Role,
      keyName: keyPair.ref,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
      machineImage: new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      securityGroup: ec2SG,
      userDataCausesReplacement: true,
    });

    const cfnIns = bastionHost.node.defaultChild as ec2.CfnInstance;
    cfnIns.addPropertyOverride('DisableApiTermination', true);
    NagSuppressions.addResourceSuppressions(bastionHost, [
      {
        id: 'AwsSolutions-EC29',
        reason: 'Remediated through property override.',
      },
      {
        id: 'AwsSolutions-EC28',
        reason: 'bastion host does not need detailed monitoring',
      },
    ]);
    

    let bastionUserData = readFileSync('./resources/bastion/bastionUserData.sh','utf8')
    bastionUserData = bastionUserData.replaceAll('${AWS::Region}',this.region)
    bastionUserData = bastionUserData.replaceAll('{$LoadBalancerDNS}',controllerLoadBalancer.loadBalancerDnsName)

    bastionHost.addUserData(bastionUserData);

    bastionHost.node.addDependency(controllerLoadBalancer);
    bastionHost.node.addDependency(pinotServerAutoscalingGroup);

    const terminationLambda = new lambda.SingletonFunction(this, 'terminationLambda', {
      uuid: '97e4f730-4ee1-11e8-3c2d-fa7ae01b6ebc',
      code: lambda.Code.fromInline(`
import cfnresponse
import json
import os
import urllib.request
import boto3

def handler(event, context):
        
    try:
        print("REQUEST RECEIVED:" + json.dumps(event));
        if(event["RequestType"] == "Create"):

            print("CREATE RESPONSE", "create_response")
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {"Message": "Resource creation successful!"})
        elif(event["RequestType"] == "Delete"):
            stackName=os.environ["stackName"]
            print("DELETE" + str("delete_response"))
            ec2 = boto3.client('ec2')
            response = ec2.describe_tags(Filters=[{'Name':'key','Values': [stackName+'-zookeeper-cluster']}])
            ec2List = list(response['Tags'])
            for element in ec2List:
                instance=element['ResourceId']
                response=ec2.delete_tags(Resources=[instance], Tags=[{'Key':stackName+'-zookeeper-cluster'}])
                print(response)
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {"Message": "Resource deletion successful!"})
        else:
            cfnresponse.send(event, context, cfnresponse.FAILED, {"Message": "Resource creation failed!"})
    except Exception as err:
        print(err)
        cfnresponse.send(event, context, cfnresponse.FAILED, {"Message:": str(type(err))})
                  `),
      handler: "index.handler",
      initialPolicy: [
        new iam.PolicyStatement(
            {
              actions: [
                "ec2:*"],
              resources: ['*']
            })
      ],
      timeout: cdk.Duration.seconds(300),
      runtime: lambda.Runtime.PYTHON_3_10,
      memorySize: 256,
      environment: {
        stackName: this.stackName
      },

    });

    NagSuppressions.addResourceSuppressions(terminationLambda, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'use ec2 and autoscaling policies'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'python 3_10 is the last version tested'
      },
      
    ]);



    const resource = new cdk.CustomResource(this, 'terminationLambdaResource', {
      serviceToken: terminationLambda.functionArn
    });


    NagSuppressions.addResourceSuppressions(resource, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'use ec2 and autoscaling policies'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'python 3_10 is the last version tested'
      },
      
    ]);


    resource.node.addDependency(pinotServerAutoscalingGroup)
    resource.node.addDependency(terminationLambda)

    //add suppression for managed policy
    NagSuppressions.addStackSuppressions(
      this,  
      [
          {
              "id": "AwsSolutions-IAM4",
              "reason": "Managed Policies are for service account roles only",
          },
          {
              "id": "AwsSolutions-IAM5",
              "reason": "Resource access restriced to ADDF resources",
          },
      ],
  )

  }


}
