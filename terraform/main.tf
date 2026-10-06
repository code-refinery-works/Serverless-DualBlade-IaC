terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags { tags = { Project = var.project, Env = var.env, ManagedBy = "terraform" } }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ── KMS CMK ──────────────────────────────────────────────
resource "aws_kms_key" "main" {
  description             = "${var.project}-${var.env}-cmk"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "RootFullAccess"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "ServiceAccess"
        Effect    = "Allow"
        Principal = { Service = ["dynamodb.amazonaws.com", "logs.${data.aws_region.current.name}.amazonaws.com"] }
        Action    = ["kms:GenerateDataKey*", "kms:Decrypt", "kms:DescribeKey"]
        Resource  = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.project}-${var.env}"
  target_key_id = aws_kms_key.main.key_id
}

# ── DynamoDB ─────────────────────────────────────────────
resource "aws_dynamodb_table" "main" {
  name         = "${var.project}-${var.env}-items"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute { name = "PK"; type = "S" }
  attribute { name = "SK"; type = "S" }

  point_in_time_recovery { enabled = true }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.main.arn
  }

  ttl { attribute_name = "ttl"; enabled = true }
}

# ── CloudWatch Log Group ──────────────────────────────────
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.project}-${var.env}-handler"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.main.arn
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigateway/${var.project}-${var.env}"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.main.arn
}

# ── SSM Parameter Store (CDKへの引き渡し) ─────────────────
resource "aws_ssm_parameter" "table_arn" {
  name  = "/${var.project}/${var.env}/dynamodb/table_arn"
  type  = "String"
  value = aws_dynamodb_table.main.arn
}

resource "aws_ssm_parameter" "table_name" {
  name  = "/${var.project}/${var.env}/dynamodb/table_name"
  type  = "String"
  value = aws_dynamodb_table.main.name
}

resource "aws_ssm_parameter" "kms_key_arn" {
  name  = "/${var.project}/${var.env}/kms/key_arn"
  type  = "String"
  value = aws_kms_key.main.arn
}

resource "aws_ssm_parameter" "lambda_log_group" {
  name  = "/${var.project}/${var.env}/cloudwatch/lambda_log_group"
  type  = "String"
  value = aws_cloudwatch_log_group.lambda.name
}