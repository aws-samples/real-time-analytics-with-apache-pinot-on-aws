#!/bin/bash

sudo amazon-linux-extras install java-openjdk11 -y

export PINOT_VERSION=1.2.0
cd /home/ec2-user
wget https://downloads.apache.org/pinot/apache-pinot-$PINOT_VERSION/apache-pinot-$PINOT_VERSION-bin.tar.gz

tar -zxvf apache-pinot-$PINOT_VERSION-bin.tar.gz

cd apache-pinot-$PINOT_VERSION-bin

zookeeperIP1=`aws ec2 describe-instances --filter "Name=tag:ApachePinotSolutionStack-zookeeper-cluster,Values=*" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].NetworkInterfaces[0].PrivateIpAddress' --region ${AWS::Region} --output text`
zookeeperIP2=`aws ec2 describe-instances --filter "Name=tag:ApachePinotSolutionStack-zookeeper-cluster,Values=*" "Name=instance-state-name,Values=running" --query 'Reservations[1].Instances[0].NetworkInterfaces[0].PrivateIpAddress' --region ${AWS::Region} --output text`
zookeeperIP3=`aws ec2 describe-instances --filter "Name=tag:ApachePinotSolutionStack-zookeeper-cluster,Values=*" "Name=instance-state-name,Values=running" --query 'Reservations[2].Instances[0].NetworkInterfaces[0].PrivateIpAddress' --region ${AWS::Region} --output text`
zookeeperaddress=$zookeeperIP1:2181,$zookeeperIP2:2181,$zookeeperIP3:2181



./bin/pinot-admin.sh StartBroker -zkAddress $zookeeperaddress -clusterName pinot-quickstart

