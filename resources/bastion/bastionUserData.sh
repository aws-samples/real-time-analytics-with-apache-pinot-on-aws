#!/bin/bash

sudo amazon-linux-extras install java-openjdk11 -y


cd /home/ec2-user
export PINOT_VERSION=0.12.1

wget https://downloads.apache.org/pinot/apache-pinot-$PINOT_VERSION/apache-pinot-$PINOT_VERSION-bin.tar.gz

tar -zxvf apache-pinot-$PINOT_VERSION-bin.tar.gz

cd apache-pinot-$PINOT_VERSION-bin

Region=${AWS::Region}

S3BucketName=`aws s3api list-buckets --query 'Buckets[*].[Name]' --output text | grep "apache-pinot-soluti" | grep "${AWS::Region}"`

aws s3 cp s3://$S3BucketName/resources/pinot/resources/kinesisTable.json ./ --region ${AWS::Region}
aws s3 cp s3://$S3BucketName/resources/pinot/resources/kinesisTableConfigFile.json ./ --region ${AWS::Region}

sed -i "s/{AWSRegion}/$Region/g" kinesisTableConfigFile.json

#add bastion host to ALB'S security group
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCEID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
PUBLIC_IP=$(aws ec2 describe-instances --instance-ids $INSTANCEID --query 'Reservations[*].Instances[*].PublicIpAddress' --output text --region $REGION)
PUBLIC_IP_WITH_CIDR="${PUBLIC_IP}/32"
VPC_ID=$(aws ec2 describe-vpcs --region $REGION --filters Name=tag:Name,Values='ApachePinotSolutionStack/VPC' --query "Vpcs[].VpcId" --output text)
SearchString="ApachePinotSolutionStack-SecurityGroupLoadBalancer"
SG_ID=$(aws ec2 describe-security-groups --region $REGION --filter Name=vpc-id,Values=$VPC_ID Name=group-name,Values=$SearchString* --query 'SecurityGroups[*].[GroupId]' --output text)
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 80 --cidr $PUBLIC_IP_WITH_CIDR --region $REGION

sleep 10
./bin/pinot-admin.sh AddTable -schemaFile kinesisTable.json -controllerHost {$LoadBalancerDNS} -tableConfigFile kinesisTableConfigFile.json -controllerPort 80 -exec > pinot_create_table_output.txt 2>&1


