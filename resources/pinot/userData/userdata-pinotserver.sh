#!/bin/bash

sudo amazon-linux-extras install java-openjdk11 -y

export PINOT_VERSION=1.2.0
cd /home/ec2-user
S3BucketName=`aws s3api list-buckets --query 'Buckets[*].[Name]' --output text | grep "apache-pinot-solution" | grep "${AWS::Region}"`
aws s3 cp s3://$S3BucketName/resources/pinot/conf/server/pinot-server.conf ./ --region ${AWS::Region}
Region=${AWS::Region}
sed -i "s/{region}/$Region/g" pinot-server.conf


wget https://downloads.apache.org/pinot/apache-pinot-$PINOT_VERSION/apache-pinot-$PINOT_VERSION-bin.tar.gz

tar -zxvf apache-pinot-$PINOT_VERSION-bin.tar.gz

cd apache-pinot-$PINOT_VERSION-bin

zookeeperIP1=`aws ec2 describe-instances --filter "Name=tag:ApachePinotSolutionStack-zookeeper-cluster,Values=*" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].NetworkInterfaces[0].PrivateIpAddress' --region ${AWS::Region} --output text`
zookeeperIP2=`aws ec2 describe-instances --filter "Name=tag:ApachePinotSolutionStack-zookeeper-cluster,Values=*" "Name=instance-state-name,Values=running" --query 'Reservations[1].Instances[0].NetworkInterfaces[0].PrivateIpAddress' --region ${AWS::Region} --output text`
zookeeperIP3=`aws ec2 describe-instances --filter "Name=tag:ApachePinotSolutionStack-zookeeper-cluster,Values=*" "Name=instance-state-name,Values=running" --query 'Reservations[2].Instances[0].NetworkInterfaces[0].PrivateIpAddress' --region ${AWS::Region} --output text`
zookeeperaddress=$zookeeperIP1:2181,$zookeeperIP2:2181,$zookeeperIP3:2181

#add Pinot Server to ALB'S security group
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCEID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
PUBLIC_IP=$(aws ec2 describe-instances --instance-ids $INSTANCEID --query 'Reservations[*].Instances[*].PublicIpAddress' --output text --region $REGION)
PUBLIC_IP_WITH_CIDR="${PUBLIC_IP}/32"
VPC_ID=$(aws ec2 describe-vpcs --region $REGION --filters Name=tag:Name,Values='ApachePinotSolutionStack/VPC' --query "Vpcs[].VpcId" --output text)
SearchString="ApachePinotSolutionStack-SecurityGroupLoadBalancer"
SG_ID=$(aws ec2 describe-security-groups --region $REGION --filter Name=vpc-id,Values=$VPC_ID Name=group-name,Values=$SearchString* --query 'SecurityGroups[*].[GroupId]' --output text)
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 80 --cidr $PUBLIC_IP_WITH_CIDR --region $REGION



./bin/pinot-admin.sh StartServer -configFileName /home/ec2-user/pinot-server.conf -zkAddress $zookeeperaddress -clusterName pinot-quickstart

