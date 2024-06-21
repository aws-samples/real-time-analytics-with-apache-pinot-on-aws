#!/bin/bash
yum update -y

sudo mkdir -p /data/

sudo mkdir -p /data/zookeeper/{data,logs}
sudo su

cd /home/ec2-user/
aws s3 cp s3://${S3BucketName}/scripts/zookeeper/zookeeper-install.sh ./ --region ${AWS::Region}
aws s3 cp s3://${S3BucketName}/scripts/zookeeper/find-zookeeper-node.py ./ --region ${AWS::Region}
chmod +x zookeeper-install.sh
./zookeeper-install.sh ${ZookeeperVersion} > zk.log

echo "3" >> /data/zookeeper/data/myid
aws ec2 create-tags --region ${AWS::Region} --resources `curl http://169.254.169.254/latest/meta-data/instance-id` --tags Key=${RootStackName}-zookeeper-cluster,Value="server.3=`curl http://169.254.169.254/latest/meta-data/local-ipv4`:2888:3888"

flag=1800
while((flag > 0))
do
  echo `aws ec2 describe-tags --filters Name=key,Values=${RootStackName}-zookeeper-cluster --region ${AWS::Region}` > instancelist
  count=`awk -v RS="@#$j" '{print gsub(/instance/,"&")}' instancelist`
  if (( $count >= ${ZookeeperNodeCount} ))
  then
    python3 find-zookeeper-node.py instancelist result
    while read line
    do
      echo $line
      echo $line >> /usr/local/apache-zookeeper-${ZookeeperVersion}-bin/conf/zoo.cfg
    done < result
    break
  fi
  echo $flag
  let flag--
  sleep 1
done

rm -rf /home/ec2-user/openjdk-8u41-b04-linux-x64-14_jan_2020.tar.gz
rm -rf /home/ec2-user/apache-zookeeper-${ZookeeperVersion}-bin.tar.gz
rm -rf /home/ec2-user/zookeeper-install.sh
rm -rf /home/ec2-user/find-zookeeper-node.py
rm -rf /home/ec2-user/instancelist
rm -rf /home/ec2-user/result

echo "/usr/local/apache-zookeeper-${ZookeeperVersion}-bin/bin/zkServer.sh start" > /home/ec2-user/zk-start.sh
chmod +x /home/ec2-user/zk-start.sh
echo "/home/ec2-user/zk-start.sh" >> /etc/rc.d/rc.local
chmod +x /etc/rc.d/rc.local

/usr/local/apache-zookeeper-${ZookeeperVersion}-bin/bin/zkServer.sh start