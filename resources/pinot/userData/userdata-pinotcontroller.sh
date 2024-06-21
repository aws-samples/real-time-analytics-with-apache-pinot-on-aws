#!/bin/bash

sudo amazon-linux-extras install java-openjdk11 -y

export PINOT_VERSION=0.12.1
cd /home/ec2-user

S3BucketName=`aws s3api list-buckets --query 'Buckets[*].[Name]' --output text | grep "apache-pinot-solution" | grep "${AWS::Region}"`

controllerIP=`curl -s http://169.254.169.254/latest/meta-data/hostname`

aws s3 cp s3://$S3BucketName/resources/pinot/conf/controller/pinot-controller.conf ./ --region ${AWS::Region}

Region=${AWS::Region}
controllerLoadBalancer=$controllerIP

sed -i "s/{bucketName}/$S3BucketName/g" pinot-controller.conf
sed -i "s/{region}/$Region/g" pinot-controller.conf
sed -i "s/{LoadBalancerDNS}/$controllerLoadBalancer/g" pinot-controller.conf


zookeeperIP1=`aws ec2 describe-instances --filter "Name=tag:ApachePinotSolutionStack-zookeeper-cluster,Values=*" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].NetworkInterfaces[0].PrivateIpAddress' --region ${AWS::Region} --output text`
zookeeperIP2=`aws ec2 describe-instances --filter "Name=tag:ApachePinotSolutionStack-zookeeper-cluster,Values=*" "Name=instance-state-name,Values=running" --query 'Reservations[1].Instances[0].NetworkInterfaces[0].PrivateIpAddress' --region ${AWS::Region} --output text`
zookeeperIP3=`aws ec2 describe-instances --filter "Name=tag:ApachePinotSolutionStack-zookeeper-cluster,Values=*" "Name=instance-state-name,Values=running" --query 'Reservations[2].Instances[0].NetworkInterfaces[0].PrivateIpAddress' --region ${AWS::Region} --output text`
zookeeperaddress=$zookeeperIP1:2181,$zookeeperIP2:2181,$zookeeperIP3:2181

sed -i "s/{zookeeperIP}/$zookeeperaddress/g" pinot-controller.conf

wget https://downloads.apache.org/pinot/apache-pinot-$PINOT_VERSION/apache-pinot-$PINOT_VERSION-bin.tar.gz

tar -zxvf apache-pinot-$PINOT_VERSION-bin.tar.gz

cd apache-pinot-$PINOT_VERSION-bin

./bin/pinot-admin.sh StartController -controllerPort 9000 -configFileName /home/ec2-user/pinot-controller.conf

