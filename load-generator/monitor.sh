#!/usr/bin/env bash
# monitor.sh - records the auto-scaling experiment as a CSV.
# Usage: ./monitor.sh geofencing-tracking
# Every 30s logs: time, ECS running/desired/pending tasks, SQS backlog.
SVC="${1:-geofencing-tracking}"
QURL="https://sqs.us-east-1.amazonaws.com/277870706905/fleet-${SVC}-queue"
OUT="scaling-${SVC}-$(date +%Y%m%d-%H%M%S).csv"
echo "time,running,desired,pending,visible,in_flight" | tee "$OUT"
while true; do
  T=$(date +%H:%M:%S)
  ECS=$(aws ecs describe-services --cluster fleet-cluster --services "$SVC" --region us-east-1 \
        --query 'services[0].[runningCount,desiredCount,pendingCount]' --output text | tr '\t' ',')
  SQS=$(aws sqs get-queue-attributes --queue-url "$QURL" --region us-east-1 \
        --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
        --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' --output text | tr '\t' ',')
  echo "$T,$ECS,$SQS" | tee -a "$OUT"
  sleep 30
done
