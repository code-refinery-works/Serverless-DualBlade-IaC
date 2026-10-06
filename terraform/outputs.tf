output "dynamodb_table_name" {
  description = "DynamoDB table name"
  value       = aws_dynamodb_table.main.name
}

output "dynamodb_table_arn" {
  description = "DynamoDB table ARN"
  value       = aws_dynamodb_table.main.arn
}

output "kms_key_arn" {
  description = "KMS CMK ARN"
  value       = aws_kms_key.main.arn
}

output "kms_key_alias" {
  description = "KMS CMK alias"
  value       = aws_kms_alias.main.name
}

output "lambda_log_group_name" {
  description = "CloudWatch Log Group for Lambda"
  value       = aws_cloudwatch_log_group.lambda.name
}

output "apigw_log_group_name" {
  description = "CloudWatch Log Group for API Gateway"
  value       = aws_cloudwatch_log_group.apigw.name
}

output "ssm_table_arn_path" {
  description = "SSM parameter path for DynamoDB table ARN"
  value       = aws_ssm_parameter.table_arn.name
}

output "ssm_kms_key_arn_path" {
  description = "SSM parameter path for KMS key ARN"
  value       = aws_ssm_parameter.kms_key_arn.name
}