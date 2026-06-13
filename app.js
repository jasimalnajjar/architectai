/* =====================================================================
   ArchitectAI — MVP mockup
   A "wizard of oz" prototype: the chat behaves like an AI architect,
   but responses are scripted/heuristic. The point is to demonstrate the
   core product loop:

      natural language  →  structured spec (JSON)  →  diagram + design doc
                         ↑__________ iterative refinement __________↓

   In the real product, the "classify/build spec" step below is replaced
   by an LLM emitting the same spec format.
   ===================================================================== */

"use strict";

/* =====================================================================
   FEEDBACK FORM LINK  ← paste your Google Forms / Tally / Typeform URL here.
   While this is empty, the "Share feedback" button stays hidden, so a
   published site never shows a dead link. Set it and the button appears.
   ===================================================================== */
const FEEDBACK_URL = "";

/* ---------------------------------------------------------------------
   Spec format
   ---------------------------------------------------------------------
   {
     title, scenario: "greenfield" | "brownfield",
     states: { target: State, current?: State },   // brownfield has both
     doc: { overview, decisions[], nfrs[], risks[], phases[] }
   }
   State = { zones: [{id,label}], nodes: [{id,zone,label,sub,kind}],
             edges: [{from,to,label,dashed?}] }
--------------------------------------------------------------------- */

const KIND_COLORS = {
  client:   { fill: "#1d2a3f", stroke: "#3e6db5", badge: "CLIENT" },
  edge:     { fill: "#172e2c", stroke: "#2f9e8f", badge: "EDGE" },
  app:      { fill: "#23253f", stroke: "#6c8cff", badge: "SERVICE" },
  data:     { fill: "#33271c", stroke: "#d99a4e", badge: "DATA" },
  async:    { fill: "#2f2138", stroke: "#a96ce0", badge: "ASYNC" },
  external: { fill: "#262a33", stroke: "#7b8499", badge: "EXTERNAL" },
  legacy:   { fill: "#36211f", stroke: "#c05b50", badge: "LEGACY" },
  ops:      { fill: "#1c3022", stroke: "#4cc38a", badge: "OPS" },
};

/* =====================================================================
   SERVICE CATALOG  ("build it" layer)
   ---------------------------------------------------------------------
   Per-component spec sheets + IaC snippets. In the real product this is
   a curated catalog the LLM selects from and parameterises — which is
   exactly why generated Terraform can be trusted: the AI picks and
   wires vetted building blocks, it doesn't freestyle HCL.
   ===================================================================== */

const CATALOG = {
  pg: {
    desc: "Primary relational store. Single writer, optional read replicas; per-service schemas keep future decomposition cheap.",
    specs: { "Engine": "PostgreSQL 16 · RDS", "Sizing": "db.r6g.large · 2 vCPU / 16 GiB · gp3 200 GiB", "HA": "Multi-AZ, automated failover", "Backups": "PITR, 7-day window + weekly snapshot to vault", "Security": "Private subnets only · TLS enforced · IAM auth · KMS at rest" },
    cost: 310,
    tf: `resource "aws_db_instance" "main" {
  identifier              = "\${local.name_prefix}-pg"
  engine                  = "postgres"
  engine_version          = "16.4"
  instance_class          = "db.r6g.large"
  allocated_storage       = 200
  storage_type            = "gp3"
  multi_az                = true
  db_subnet_group_name    = aws_db_subnet_group.private.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  storage_encrypted       = true
  kms_key_id              = aws_kms_key.data.arn
  backup_retention_period = 7
  deletion_protection     = true
  tags                    = local.tags
}`,
    cfn: `  Database:
    Type: AWS::RDS::DBInstance
    Properties:
      Engine: postgres
      EngineVersion: "16.4"
      DBInstanceClass: db.r6g.large
      AllocatedStorage: "200"
      MultiAZ: true
      StorageEncrypted: true
      BackupRetentionPeriod: 7
      DeletionProtection: true`,
  },
  redis: {
    desc: "Look-aside cache for hot reads and session state. Treat as ephemeral: the app must function (slower) with a cold cache.",
    specs: { "Engine": "Redis 7 · ElastiCache", "Sizing": "cache.r7g.large × 2 (primary + replica)", "HA": "Automatic failover, multi-AZ", "Eviction": "allkeys-lru · TTL-first design", "Security": "In-transit TLS · AUTH token · private subnets" },
    cost: 240,
    tf: `resource "aws_elasticache_replication_group" "cache" {
  replication_group_id       = "\${local.name_prefix}-cache"
  description                = "App look-aside cache"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.r7g.large"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.private.name
  tags                       = local.tags
}`,
    cfn: `  Cache:
    Type: AWS::ElastiCache::ReplicationGroup
    Properties:
      ReplicationGroupDescription: App look-aside cache
      Engine: redis
      CacheNodeType: cache.r7g.large
      NumCacheClusters: 2
      AutomaticFailoverEnabled: true
      MultiAZEnabled: true
      TransitEncryptionEnabled: true`,
  },
  s3: {
    desc: "Object storage for assets, exports, and document uploads. Versioned, lifecycle-tiered to cut cost on cold objects.",
    specs: { "Service": "S3 · one bucket per concern", "Lifecycle": "IA after 30 d · Glacier after 180 d", "Security": "Block public access · SSE-KMS · access via presigned URLs", "DR": "Versioning on; optional cross-region replication" },
    cost: 25,
    tf: `resource "aws_s3_bucket" "assets" {
  bucket = "\${local.name_prefix}-assets"
  tags   = local.tags
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}`,
    cfn: `  AssetsBucket:
    Type: AWS::S3::Bucket
    Properties:
      VersioningConfiguration: { Status: Enabled }
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true`,
  },
  queue: {
    desc: "Async backbone: domain events fan out to consumers; side effects leave the request path. DLQs are non-negotiable.",
    specs: { "Service": "SQS + EventBridge bus", "Delivery": "At-least-once · consumers must be idempotent", "DLQ": "After 5 receives · alarmed at depth > 0", "Security": "SSE · per-service IAM publish/consume policies" },
    cost: 15,
    tf: `resource "aws_sqs_queue" "events_dlq" {
  name = "\${local.name_prefix}-events-dlq"
  tags = local.tags
}

resource "aws_sqs_queue" "events" {
  name                       = "\${local.name_prefix}-events"
  visibility_timeout_seconds = 60
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.events_dlq.arn
    maxReceiveCount     = 5
  })
  tags = local.tags
}`,
    cfn: `  EventsQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 60
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt EventsDLQ.Arn
        maxReceiveCount: 5
  EventsDLQ:
    Type: AWS::SQS::Queue`,
  },
  api: {
    desc: "The modular monolith: one deployable, strictly bounded internal modules. Stateless — all state lives in the data tier.",
    specs: { "Runtime": "Node 22 / TypeScript · ECS Fargate", "Sizing": "2 vCPU / 4 GiB × 2 tasks (autoscale to 10 on CPU > 60%)", "Deploys": "Blue/green via CodeDeploy · health-gated", "Security": "Task-role IAM · secrets from Secrets Manager · no public IP" },
    cost: 175,
    tf: `resource "aws_ecs_service" "api" {
  name            = "\${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = local.private_subnets
    security_groups = [aws_security_group.api.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = 10
  min_capacity       = 2
  resource_id        = "service/\${aws_ecs_cluster.main.name}/\${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}`,
    cfn: `  ApiService:
    Type: AWS::ECS::Service
    Properties:
      Cluster: !Ref Cluster
      DesiredCount: 2
      LaunchType: FARGATE
      TaskDefinition: !Ref ApiTaskDef`,
  },
  gw: {
    desc: "Single entry point: authN at the edge, rate limits per client, request logging. For brownfield, also the strangler routing layer.",
    specs: { "Service": "API Gateway (HTTP API) / ALB", "Auth": "JWT authorizer against the IdP", "Limits": "Per-key throttling · WAF managed rules upstream", "Observability": "Access logs → centralized, 1 yr retention" },
    cost: 35,
    tf: `resource "aws_apigatewayv2_api" "gw" {
  name          = "\${local.name_prefix}-gw"
  protocol_type = "HTTP"
  tags          = local.tags
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.gw.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "oidc"

  jwt_configuration {
    audience = [var.oidc_audience]
    issuer   = var.oidc_issuer
  }
}`,
    cfn: `  HttpApi:
    Type: AWS::ApiGatewayV2::Api
    Properties:
      ProtocolType: HTTP`,
  },
  cdn: {
    desc: "Edge termination: static assets, cacheable API responses, TLS, and DDoS absorption. WAF managed rules in blocking mode.",
    specs: { "Service": "CloudFront + AWS WAF", "Caching": "Assets 1 yr immutable · API per-route TTLs", "Security": "TLS 1.2+ · OWASP managed rule set · geo controls available" },
    cost: 45,
    tf: `resource "aws_cloudfront_distribution" "cdn" {
  enabled         = true
  is_ipv6_enabled = true
  web_acl_id      = aws_wafv2_web_acl.main.arn

  origin {
    domain_name = aws_lb.main.dns_name
    origin_id   = "app"
    custom_origin_config {
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      http_port              = 80
      https_port             = 443
    }
  }

  default_cache_behavior {
    target_origin_id       = "app"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
  }

  restrictions { geo_restriction { restriction_type = "none" } }
  viewer_certificate { cloudfront_default_certificate = true }
  tags = local.tags
}`,
    cfn: null,
  },
  auth: {
    desc: "Identity broker: OIDC for the product, SAML federation for enterprise customers later. Buy, don't build.",
    specs: { "Service": "Cognito or Auth0", "Protocols": "OIDC · PKCE for SPA · SAML federation (roadmap)", "MFA": "TOTP enforced for admin roles", "Tokens": "15 min access / rotating refresh" },
    cost: 50,
    tf: `resource "aws_cognito_user_pool" "main" {
  name = "\${local.name_prefix}-users"

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_numbers   = true
  }

  mfa_configuration = "OPTIONAL"
  tags              = local.tags
}`,
    cfn: null,
  },
  worker: {
    desc: "Async consumers: emails, exports, third-party syncs. Same codebase as the API (modular monolith), different entrypoint.",
    specs: { "Runtime": "ECS Fargate · queue-depth autoscaling", "Sizing": "1 vCPU / 2 GiB × 1–8 tasks", "Retries": "Backoff + DLQ · idempotency keys on all jobs" },
    cost: 110,
    tf: `resource "aws_ecs_service" "worker" {
  name            = "\${local.name_prefix}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = local.private_subnets
    security_groups = [aws_security_group.worker.id]
  }
}`,
    cfn: null,
  },
  obs: {
    desc: "Observability baseline from day one: structured logs, traces, RED dashboards, and alerts wired to on-call.",
    specs: { "Stack": "CloudWatch + OpenTelemetry (or Datadog)", "Golden signals": "Rate, errors, duration per route · queue depth · DB saturation", "Alerting": "p95 latency, 5xx rate, DLQ depth → PagerDuty" },
    cost: 150,
    tf: `resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "\${local.name_prefix}-api-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.oncall.arn]
  tags                = local.tags
}`,
    cfn: null,
  },
  pay: {
    desc: "Payments isolated behind its own service boundary: PCI scope containment, idempotent operations, double-entry ledger.",
    specs: { "Runtime": "Dedicated ECS service · separate task role", "Pattern": "Idempotency keys · outbox → event bus · nightly PSP reconciliation", "Compliance": "SAQ-A posture — card data never touches our infra" },
    cost: 120,
    tf: `resource "aws_ecs_service" "payments" {
  name            = "\${local.name_prefix}-payments"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.payments.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = local.private_subnets
    security_groups = [aws_security_group.payments.id]
  }
}`,
    cfn: null,
  },
  aisvc: {
    desc: "Thin service owning prompts, retrieval, guardrails, and evals. The product never calls the LLM provider directly.",
    specs: { "Runtime": "ECS Fargate · streaming responses", "Guardrails": "Input/output filters · per-tenant token budgets · response cache", "Evals": "Golden-set regression on every prompt change" },
    cost: 140,
    tf: `resource "aws_ecs_service" "ai" {
  name            = "\${local.name_prefix}-ai"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.ai.arn
  desired_count   = 2
  launch_type     = "FARGATE"
}

resource "aws_secretsmanager_secret" "llm_api_key" {
  name = "\${local.name_prefix}/llm-api-key"
  tags = local.tags
}`,
    cfn: null,
  },
  vec: {
    desc: "Vector store for retrieval. Start with pgvector in the existing Postgres; move to a dedicated store only if recall/scale demands it.",
    specs: { "Engine": "pgvector extension (initially)", "Index": "HNSW · cosine", "Why not dedicated": "One less system; revisit past ~10M vectors" },
    cost: 0,
    tf: `# pgvector lives inside the main Postgres instance:
resource "null_resource" "enable_pgvector" {
  provisioner "local-exec" {
    command = "psql \${var.db_url} -c 'CREATE EXTENSION IF NOT EXISTS vector;'"
  }
}`,
    cfn: null,
  },
  ws: {
    desc: "Long-lived WebSocket connections isolated from the request/response tier so deploys never drop sessions.",
    specs: { "Service": "API Gateway WebSocket / dedicated Fargate tier", "Fan-out": "Subscribed to the event bus", "Scale": "Connection-count autoscaling" },
    cost: 70,
    tf: `resource "aws_apigatewayv2_api" "ws" {
  name                       = "\${local.name_prefix}-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
  tags                       = local.tags
}`,
    cfn: null,
  },
  os: {
    desc: "Full-text and faceted search. Indexed asynchronously off the event bus — search lags writes by seconds, by design.",
    specs: { "Service": "OpenSearch · 3 × r7g.large.search", "HA": "3 AZs · dedicated masters at scale", "Security": "Fine-grained access control · VPC-only" },
    cost: 420,
    tf: `resource "aws_opensearch_domain" "search" {
  domain_name    = "\${local.name_prefix}-search"
  engine_version = "OpenSearch_2.13"

  cluster_config {
    instance_type  = "r7g.large.search"
    instance_count = 3
    zone_awareness_enabled = true
  }

  ebs_options {
    ebs_enabled = true
    volume_size = 100
  }
  tags = local.tags
}`,
    cfn: null,
  },
  dr: {
    desc: "Warm standby in a second region: replicated data tier, pre-provisioned (scaled-down) app tier, DNS failover.",
    specs: { "Posture": "Warm standby · RTO ≈ 15 min · RPO ≈ 1 min", "Data": "Cross-region read replica, promotable", "Failover": "Route 53 health checks · quarterly game days" },
    cost: 380,
    tf: `resource "aws_db_instance" "replica_dr" {
  provider            = aws.dr_region
  identifier          = "\${local.name_prefix}-pg-dr"
  replicate_source_db = aws_db_instance.main.arn
  instance_class      = "db.r6g.large"
  tags                = local.tags
}

resource "aws_route53_health_check" "primary" {
  fqdn              = aws_lb.main.dns_name
  type              = "HTTPS"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30
}`,
    cfn: null,
  },
  // ----- brownfield target -----
  orders: {
    desc: "First strangler extraction. Owns the order lifecycle end-to-end, including its own schema — no reach-back into Oracle.",
    specs: { "Runtime": "Spring Boot / ECS Fargate", "Data": "Own Postgres schema · consumes legacy via CDC topics", "Cutover": "Shadow traffic → 1% canary → 100% at the gateway" },
    cost: 175,
    tf: `resource "aws_ecs_service" "orders" {
  name            = "\${local.name_prefix}-orders"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.orders.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = local.private_subnets
    security_groups = [aws_security_group.orders.id]
  }
}`,
    cfn: null,
  },
  cust: {
    desc: "Second extraction, applying the pattern proven on Orders. Owns customer master data going forward.",
    specs: { "Runtime": "Spring Boot / ECS Fargate", "Data": "Own Postgres schema · publishes customer-changed events", "MDM note": "Becomes the system of record once the monolith's writes are cut over" },
    cost: 175,
    tf: `resource "aws_ecs_service" "customers" {
  name            = "\${local.name_prefix}-customers"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.customers.arn
  desired_count   = 2
  launch_type     = "FARGATE"
}`,
    cfn: null,
  },
  bus: {
    desc: "Integration backbone for extracted services and CDC streams. Managed Kafka — the team shouldn't run ZooKeeper in year one.",
    specs: { "Service": "Amazon MSK · 3 × kafka.m7g.large", "Governance": "Schema registry, BACKWARD compatibility enforced", "Retention": "7 d default · compacted topics for entity state" },
    cost: 580,
    tf: `resource "aws_msk_cluster" "bus" {
  cluster_name           = "\${local.name_prefix}-bus"
  kafka_version          = "3.7.x"
  number_of_broker_nodes = 3

  broker_node_group_info {
    instance_type   = "kafka.m7g.large"
    client_subnets  = local.private_subnets
    security_groups = [aws_security_group.kafka.id]
    storage_info {
      ebs_storage_info { volume_size = 500 }
    }
  }
  tags = local.tags
}`,
    cfn: `  KafkaCluster:
    Type: AWS::MSK::Cluster
    Properties:
      ClusterName: integration-bus
      KafkaVersion: "3.7.x"
      NumberOfBrokerNodes: 3
      BrokerNodeGroupInfo:
        InstanceType: kafka.m7g.large
        ClientSubnets: [!Ref SubnetA, !Ref SubnetB, !Ref SubnetC]`,
  },
  cdc: {
    desc: "Debezium tails Oracle redo logs and publishes row-level changes to Kafka — new services consume legacy data with zero monolith changes.",
    specs: { "Stack": "Debezium on MSK Connect", "Lag SLO": "< 30 s, alarmed", "Reconciliation": "Weekly row-count + checksum job Oracle ↔ Postgres", "Licence flag": "Confirm Oracle licence permits log mining" },
    cost: 160,
    tf: `resource "aws_mskconnect_connector" "oracle_cdc" {
  name                 = "\${local.name_prefix}-oracle-cdc"
  kafkaconnect_version = "2.7.1"

  connector_configuration = {
    "connector.class" = "io.debezium.connector.oracle.OracleConnector"
    "database.hostname" = var.oracle_host
    "database.dbname"   = var.oracle_sid
    "table.include.list" = "APP.ORDERS,APP.CUSTOMERS"
    "snapshot.mode"      = "initial"
  }

  capacity {
    provisioned_capacity {
      mcu_count    = 2
      worker_count = 1
    }
  }
}`,
    cfn: null,
  },
  // ----- data platform -----
  kafka: {
    desc: "Single ingestion backbone: product events and CDC streams land here before anything else touches them.",
    specs: { "Service": "Amazon MSK · 3 × kafka.m7g.large", "Throughput": "Sized for 50k events/s sustained, 10× burst", "Governance": "Schema registry mandatory on all topics" },
    cost: 580,
    tf: `resource "aws_msk_cluster" "ingest" {
  cluster_name           = "\${local.name_prefix}-ingest"
  kafka_version          = "3.7.x"
  number_of_broker_nodes = 3

  broker_node_group_info {
    instance_type   = "kafka.m7g.large"
    client_subnets  = local.private_subnets
    security_groups = [aws_security_group.kafka.id]
    storage_info {
      ebs_storage_info { volume_size = 1000 }
    }
  }
  tags = local.tags
}`,
    cfn: null,
  },
  lake: {
    desc: "Lakehouse on open table formats: raw (Bronze) through modelled (Gold) zones, readable by any engine.",
    specs: { "Storage": "S3 + Apache Iceberg · AWS Glue catalog", "Layout": "Bronze / Silver / Gold · PII masked at Silver", "Lifecycle": "Bronze → IA after 90 d" },
    cost: 180,
    tf: `resource "aws_s3_bucket" "lake" {
  bucket = "\${local.name_prefix}-lake"
  tags   = local.tags
}

resource "aws_glue_catalog_database" "lake" {
  name = "\${replace(local.name_prefix, "-", "_")}_lake"
}`,
    cfn: null,
  },
  flink: {
    desc: "Stream processing for the sub-second path: sessionisation, aggregations, feature computation.",
    specs: { "Service": "Managed Flink (Kinesis Analytics)", "Sizing": "4 KPUs to start", "State": "RocksDB · checkpoints to S3 every 60 s" },
    cost: 480,
    tf: `resource "aws_kinesisanalyticsv2_application" "flink" {
  name                   = "\${local.name_prefix}-stream-proc"
  runtime_environment    = "FLINK-1_19"
  service_execution_role = aws_iam_role.flink.arn

  application_configuration {
    application_code_configuration {
      code_content_type = "ZIPFILE"
      code_content {
        s3_content_location {
          bucket_arn = aws_s3_bucket.artifacts.arn
          file_key   = "flink/app.zip"
        }
      }
    }
  }
  tags = local.tags
}`,
    cfn: null,
  },
  dbt: {
    desc: "Transformation as code: tested, version-controlled SQL models with lineage. Runs on a schedule against the warehouse.",
    specs: { "Stack": "dbt Core on ECS scheduled tasks (or dbt Cloud)", "Layers": "staging → intermediate → marts", "Quality": "not_null/unique/accepted_values tests gate every run" },
    cost: 60,
    tf: `resource "aws_scheduler_schedule" "dbt_hourly" {
  name                = "\${local.name_prefix}-dbt-run"
  schedule_expression = "rate(1 hour)"

  flexible_time_window { mode = "OFF" }

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.dbt.arn
      launch_type         = "FARGATE"
    }
  }
}`,
    cfn: null,
  },
  wh: {
    desc: "Analytical serving layer. Reads Gold tables; auto-suspend keeps idle cost near zero.",
    specs: { "Engine": "Snowflake (or Trino on the lake)", "Cost controls": "Per-team resource monitors · auto-suspend 60 s", "Access": "SSO · row-level policies on PII marts" },
    cost: 800,
    tf: `# Snowflake is provisioned via its own provider:
resource "snowflake_warehouse" "analytics" {
  name           = "ANALYTICS_WH"
  warehouse_size = "MEDIUM"
  auto_suspend   = 60
  auto_resume    = true
}`,
    cfn: null,
  },
  elt: {
    desc: "Managed connectors for SaaS sources. Connector maintenance is undifferentiated heavy lifting — buy it.",
    specs: { "Service": "Fivetran / Airbyte Cloud", "Sources": "Salesforce, Stripe, HubSpot, …", "Landing": "Raw schemas in the lake, dbt takes it from there" },
    cost: 350,
    tf: `# Managed via the Fivetran provider:
resource "fivetran_connector" "salesforce" {
  group_id = fivetran_group.main.id
  service  = "salesforce"

  destination_schema { name = "salesforce" }
}`,
    cfn: null,
  },
  rtapi: {
    desc: "Low-latency feature serving for product surfaces: 'viewers right now', live counters, realtime personalisation inputs.",
    specs: { "Runtime": "ECS Fargate + ElastiCache for hot features", "SLO": "p99 < 50 ms reads", "Source": "Flink writes features; API only reads" },
    cost: 190,
    tf: `resource "aws_ecs_service" "rt_api" {
  name            = "\${local.name_prefix}-rt-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.rt_api.arn
  desired_count   = 2
  launch_type     = "FARGATE"
}`,
    cfn: null,
  },
  bi: {
    desc: "Dashboards and the metrics layer. Aim 70%+ of queries at pre-aggregated Gold tables.",
    specs: { "Stack": "Looker / Metabase / QuickSight", "Governance": "Certified datasets only on exec dashboards" },
    cost: 250, tf: null, cfn: null,
  },
};

/* fallbacks by kind for nodes without a catalog entry */
const KIND_META = {
  client:   { desc: "Client application. Built and deployed from its own repo; consumes the platform via the gateway.", cost: 0, specs: { "Delivery": "CI/CD per app · feature-flagged releases" } },
  external: { desc: "External/SaaS dependency. Integrated via API + webhooks; cost is usage-based.", cost: null, specs: { "Contract": "Webhook signatures verified · sandbox env for testing" } },
  legacy:   { desc: "Existing estate — part of the current state. No new IaC; it is being strangled, not rebuilt.", cost: null, specs: { "Posture": "Freeze new features · instrument · extract" } },
  app:      { desc: "Application service on the shared container platform.", cost: 160, specs: { "Runtime": "ECS Fargate · 2 tasks · autoscaling" } },
  data:     { desc: "Managed data service, private-subnet only, encrypted at rest.", cost: 200, specs: { "Security": "KMS at rest · TLS in transit" } },
  async:    { desc: "Asynchronous integration component.", cost: 80, specs: { "Delivery": "At-least-once · DLQ + alarm" } },
  edge:     { desc: "Edge/ingress component: TLS, auth, rate limiting.", cost: 40, specs: { "Security": "TLS 1.2+ · WAF upstream" } },
  ops:      { desc: "Operational tooling.", cost: 120, specs: { "Wiring": "Alerts → on-call rotation" } },
};

function metaFor(node) {
  const cat = CATALOG[node.id] || {};
  const fb = KIND_META[node.kind] || KIND_META.app;
  return {
    desc: cat.desc || fb.desc,
    specs: cat.specs || fb.specs,
    cost: "cost" in cat ? cat.cost : fb.cost,
    tf: cat.tf || null,
    cfn: cat.cfn || null,
  };
}

function fmtCost(c) {
  if (c === null) return "n/a";
  if (c === 0) return "$0";
  return "$" + c.toLocaleString();
}

function totalCost(spec) {
  return spec.states.target.nodes.reduce((sum, n) => sum + (metaFor(n).cost || 0), 0);
}

/* =====================================================================
   BUILD-PACK GENERATORS  (spec → Terraform / CFN / ADRs / backlog)
   ===================================================================== */

function buildableNodes(spec) {
  return spec.states.target.nodes.filter(n => metaFor(n).tf);
}

function genTerraform(spec) {
  const nodes = buildableNodes(spec);
  let out = `# ============================================================
# ${spec.title} — Terraform skeleton
# Generated by ArchitectAI (mockup) · spec v${spec._version || 1}
#
# Review before applying: wire in your org's state backend,
# VPC module, tagging standards, and account structure.
# ============================================================

terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # backend "s3" { ... }   # TODO: org state backend
}

provider "aws" {
  region = var.region
}

locals {
  name_prefix     = var.project_name
  private_subnets = var.private_subnet_ids   # TODO: from your VPC module
  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
    Source    = "architectai-spec-v${spec._version || 1}"
  }
}
`;
  for (const n of nodes) {
    const m = metaFor(n);
    out += `\n# ------------------------------------------------------------\n`;
    out += `# ${n.label}${n.sub ? " — " + n.sub : ""}\n`;
    out += `# ------------------------------------------------------------\n`;
    out += m.tf + "\n";
  }
  const skipped = spec.states.target.nodes.filter(n => !metaFor(n).tf);
  if (skipped.length) {
    out += `\n# Not provisioned here (clients, SaaS, legacy estate):\n`;
    out += skipped.map(n => `#   - ${n.label} (${n.sub || n.kind})`).join("\n") + "\n";
  }
  return out;
}

function genCloudFormation(spec) {
  const nodes = spec.states.target.nodes;
  let out = `AWSTemplateFormatVersion: "2010-09-09"
Description: >
  ${spec.title} — generated by ArchitectAI (mockup), spec v${spec._version || 1}.
  Partial template: components marked TODO have Terraform snippets instead
  (see the Terraform artifact), or are clients/SaaS/legacy estate.

Resources:
`;
  let any = false;
  for (const n of nodes) {
    const m = metaFor(n);
    if (m.cfn) { out += `\n  # --- ${n.label}${n.sub ? " — " + n.sub : ""} ---\n` + m.cfn + "\n"; any = true; }
  }
  if (!any) out += "  # (no CFN-mapped components in this design — see Terraform artifact)\n";
  const todo = nodes.filter(n => !metaFor(n).cfn);
  if (todo.length) {
    out += `\n  # TODO (not in this template):\n`;
    out += todo.map(n => `  #   - ${n.label}`).join("\n") + "\n";
  }
  return out;
}

function genADRs(spec) {
  const date = new Date().toISOString().slice(0, 10);
  let out = `# Architecture Decision Records — ${spec.title}\n`;
  out += `_Generated by ArchitectAI (mockup) · ${date} · spec v${spec._version || 1}_\n`;
  spec.doc.decisions.forEach(([title, rationale], i) => {
    const n = String(i + 1).padStart(3, "0");
    out += `\n---\n\n## ADR-${n}: ${title}\n\n`;
    out += `**Status:** Proposed · **Date:** ${date}\n\n`;
    out += `### Context\n\n${rationale}\n\n`;
    out += `### Decision\n\nWe will adopt: **${title.toLowerCase()}**.\n\n`;
    out += `### Consequences\n\nThe trade-offs above are accepted. Revisit if the underlying assumptions (scale, team size, compliance scope) change materially.\n`;
  });
  return out;
}

function genBacklogRows(spec) {
  const rows = []; // [type, summary, description, epic, estimate]
  const phases = spec.doc.phases;
  const epicNames = phases.map(([t]) => t.split("·")[0].trim());

  phases.forEach(([t, desc], i) => {
    rows.push(["Epic", epicNames[i] + ": " + t.split("·").slice(1).join("·").trim(), desc, "", ""]);
  });

  const firstEpic = epicNames[0] || "Phase 1";
  rows.push(["Story", "Stand up CI/CD pipeline", "Trunk-based, build + test + deploy to a dev environment on every merge.", firstEpic, "5"]);
  rows.push(["Story", "Provision base networking & accounts", "VPC, subnets, IAM baseline per the Terraform skeleton.", firstEpic, "8"]);

  for (const n of spec.states.target.nodes) {
    const m = metaFor(n);
    if (n.kind === "legacy") continue;
    const verb = m.tf ? "Provision & configure" : n.kind === "client" ? "Scaffold" : "Integrate";
    const epic = epicNames[Math.min(n.kind === "client" || m.tf ? 0 : 1, epicNames.length - 1)] || firstEpic;
    rows.push(["Story", `${verb} ${n.label}`, `${m.desc} ${n.sub ? "(" + n.sub + ")" : ""}`.trim(), epic, m.tf ? "5" : "3"]);
  }
  rows.push(["Story", "Observability baseline", "Dashboards for golden signals, alerts wired to on-call.", firstEpic, "5"]);
  rows.push(["Story", "Security review & threat model", "STRIDE pass over the design; findings become backlog items.", epicNames[epicNames.length - 1] || firstEpic, "8"]);
  return rows;
}

function genBacklogCSV(spec) {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const rows = genBacklogRows(spec);
  return ["Type,Summary,Description,Epic,Estimate"]
    .concat(rows.map(r => r.map(q).join(",")))
    .join("\n");
}

/* =====================================================================
   SCENARIO LIBRARY
   ===================================================================== */

function greenfieldSpec(userInput, addons) {
  const zones = [
    { id: "clients", label: "Clients" },
    { id: "edge", label: "Edge" },
    { id: "app", label: "Application" },
    { id: "data", label: "Data" },
    { id: "ext", label: "External / Async" },
  ];
  const nodes = [
    { id: "web", zone: "clients", label: "Web App", sub: "Next.js · SSR", kind: "client" },
    { id: "cdn", zone: "edge", label: "CDN + WAF", sub: "CloudFront", kind: "edge" },
    { id: "gw", zone: "edge", label: "API Gateway", sub: "Auth, rate limits", kind: "edge" },
    { id: "api", zone: "app", label: "Core API", sub: "Node/TS · ECS Fargate", kind: "app" },
    { id: "auth", zone: "app", label: "Identity", sub: "OIDC · Cognito/Auth0", kind: "app" },
    { id: "pg", zone: "data", label: "PostgreSQL", sub: "RDS · Multi-AZ", kind: "data" },
    { id: "s3", zone: "data", label: "Object Store", sub: "S3 · assets, exports", kind: "data" },
    { id: "queue", zone: "ext", label: "Event Bus", sub: "SQS/EventBridge", kind: "async" },
    { id: "worker", zone: "ext", label: "Workers", sub: "Async jobs, emails", kind: "async" },
    { id: "obs", zone: "ext", label: "Observability", sub: "Logs · traces · alerts", kind: "ops" },
  ];
  const edges = [
    { from: "web", to: "cdn", label: "HTTPS" },
    { from: "cdn", to: "gw" },
    { from: "gw", to: "api", label: "REST/JSON" },
    { from: "gw", to: "auth", label: "OIDC", dashed: true },
    { from: "api", to: "pg", label: "SQL" },
    { from: "api", to: "s3" },
    { from: "api", to: "queue", label: "events" },
    { from: "queue", to: "worker" },
  ];
  const decisions = [
    ["Managed-first on a single cloud", "At MVP scale, managed services (RDS, Fargate, SQS) minimise ops burden; portability can be reclaimed later via containers."],
    ["Modular monolith over microservices", "One deployable with enforced module boundaries. Split services only when team size or scaling pressure demands it."],
    ["API Gateway as the single entry point", "Centralises authN, rate limiting, and request logging from day one."],
    ["Event bus for side effects", "Emails, notifications, and integrations run async so the request path stays fast and resilient."],
  ];
  const nfrs = [
    ["Availability", "99.9% — multi-AZ data tier, stateless app tier behind a load balancer"],
    ["Latency", "p95 < 300 ms for API reads; CDN for static assets"],
    ["Scalability", "Horizontal autoscaling on the app tier; read replicas when needed"],
    ["Security", "TLS everywhere, OIDC, least-privilege IAM, secrets in a vault"],
    ["Cost", "Estimated $600–1,200/mo at launch scale (excl. egress spikes)"],
  ];
  const risks = [
    ["med", "Single-region deployment — an AWS regional outage takes the product down. Acceptable for MVP; revisit at first enterprise customer."],
    ["med", "Modular monolith requires discipline — without enforced module boundaries it degrades into a big ball of mud."],
    ["low", "Vendor lock-in to AWS managed services — mitigated by containerised app tier."],
  ];

  // keyword add-ons
  if (addons.has("payments")) {
    nodes.push({ id: "pay", zone: "app", label: "Payments Svc", sub: "Idempotent · ledger", kind: "app" });
    nodes.push({ id: "stripe", zone: "ext", label: "Stripe", sub: "PSP · webhooks", kind: "external" });
    edges.push({ from: "api", to: "pay" }, { from: "pay", to: "stripe", label: "PSP API", dashed: true }, { from: "stripe", to: "queue", label: "webhooks", dashed: true });
    decisions.push(["Payments isolated behind its own service", "PCI scope containment: card data never touches the core API; Stripe holds the sensitive surface."]);
    risks.push(["high", "Webhook-driven payment state is eventually consistent — reconcile with a nightly ledger sweep against Stripe."]);
  }
  if (addons.has("ai")) {
    nodes.push({ id: "aisvc", zone: "app", label: "AI Service", sub: "Prompting · guardrails", kind: "app" });
    nodes.push({ id: "vec", zone: "data", label: "Vector Store", sub: "pgvector / Pinecone", kind: "data" });
    nodes.push({ id: "llm", zone: "ext", label: "LLM Provider", sub: "Claude API", kind: "external" });
    edges.push({ from: "api", to: "aisvc" }, { from: "aisvc", to: "vec", label: "kNN" }, { from: "aisvc", to: "llm", label: "inference", dashed: true });
    decisions.push(["Thin AI service over the LLM provider", "Keeps prompts, evals, and guardrails in one place; provider can be swapped without touching product code."]);
    risks.push(["med", "LLM latency and cost are workload-dependent — add response caching and per-tenant budgets early."]);
  }
  if (addons.has("realtime")) {
    nodes.push({ id: "ws", zone: "edge", label: "Realtime GW", sub: "WebSocket fan-out", kind: "edge" });
    edges.push({ from: "web", to: "ws", label: "WSS", dashed: true }, { from: "queue", to: "ws", label: "push" });
    decisions.push(["Dedicated WebSocket gateway", "Long-lived connections are isolated from the request/response tier so deploys don't drop sessions."]);
  }
  if (addons.has("mobile")) {
    nodes.unshift({ id: "mob", zone: "clients", label: "Mobile App", sub: "iOS / Android", kind: "client" });
    edges.push({ from: "mob", to: "gw", label: "HTTPS" });
  }
  if (addons.has("search")) {
    nodes.push({ id: "os", zone: "data", label: "Search", sub: "OpenSearch", kind: "data" });
    edges.push({ from: "api", to: "os", label: "query" }, { from: "worker", to: "os", label: "index", dashed: true });
  }

  return {
    title: "Greenfield Solution Design",
    scenario: "greenfield",
    states: { target: { zones, nodes, edges } },
    doc: {
      overview:
        `Proposed architecture for: “${userInput.trim()}”. ` +
        "The design optimises for speed-to-market with a managed, single-cloud stack, " +
        "while keeping clean seams (gateway, event bus, module boundaries) so the system " +
        "can be decomposed as the product and team grow.",
      decisions, nfrs, risks,
      phases: [
        ["Phase 1 · Weeks 1–4", "Walking skeleton: gateway → API → Postgres, CI/CD, observability baseline, auth."],
        ["Phase 2 · Weeks 5–8", "Core product features, async pipeline (events + workers), staging environment."],
        ["Phase 3 · Weeks 9–12", "Hardening: load tests, security review, backup/restore drills, launch."],
      ],
    },
  };
}

function brownfieldSpec(userInput) {
  const current = {
    zones: [
      { id: "clients", label: "Clients" },
      { id: "app", label: "On-prem Application" },
      { id: "data", label: "Data" },
      { id: "batch", label: "Batch / Integrations" },
    ],
    nodes: [
      { id: "web", zone: "clients", label: "Web UI", sub: "JSP · server-rendered", kind: "client" },
      { id: "mono", zone: "app", label: "Java Monolith", sub: "~800k LOC · WebLogic", kind: "legacy" },
      { id: "ora", zone: "data", label: "Oracle DB", sub: "Shared schema · PL/SQL", kind: "legacy" },
      { id: "fs", zone: "data", label: "NFS Share", sub: "Documents, exports", kind: "legacy" },
      { id: "cron", zone: "batch", label: "Cron Jobs", sub: "Nightly ETL · shell", kind: "legacy" },
      { id: "edi", zone: "batch", label: "Partner EDI", sub: "SFTP drops", kind: "external" },
    ],
    edges: [
      { from: "web", to: "mono", label: "HTTP" },
      { from: "mono", to: "ora", label: "JDBC" },
      { from: "mono", to: "fs" },
      { from: "cron", to: "ora", label: "ETL" },
      { from: "edi", to: "cron", label: "SFTP", dashed: true },
    ],
  };

  const target = {
    zones: [
      { id: "clients", label: "Clients" },
      { id: "edge", label: "Edge" },
      { id: "app", label: "Services (extracted)" },
      { id: "legacy", label: "Remaining Monolith" },
      { id: "data", label: "Data" },
    ],
    nodes: [
      { id: "web", zone: "clients", label: "Web App", sub: "React SPA", kind: "client" },
      { id: "gw", zone: "edge", label: "API Gateway", sub: "Strangler routing", kind: "edge" },
      { id: "orders", zone: "app", label: "Orders Svc", sub: "First extraction", kind: "app" },
      { id: "cust", zone: "app", label: "Customer Svc", sub: "Second extraction", kind: "app" },
      { id: "bus", zone: "app", label: "Event Bus", sub: "Kafka", kind: "async" },
      { id: "mono", zone: "legacy", label: "Java Monolith", sub: "Shrinking core", kind: "legacy" },
      { id: "pg", zone: "data", label: "PostgreSQL", sub: "Per-service schemas", kind: "data" },
      { id: "ora", zone: "data", label: "Oracle DB", sub: "Legacy, CDC-tapped", kind: "legacy" },
      { id: "cdc", zone: "data", label: "CDC Pipeline", sub: "Debezium", kind: "async" },
    ],
    edges: [
      { from: "web", to: "gw", label: "HTTPS" },
      { from: "gw", to: "orders", label: "/orders/*" },
      { from: "gw", to: "cust", label: "/customers/*" },
      { from: "gw", to: "mono", label: "everything else", dashed: true },
      { from: "orders", to: "pg" },
      { from: "cust", to: "pg" },
      { from: "orders", to: "bus", label: "events" },
      { from: "mono", to: "ora", label: "JDBC" },
      { from: "ora", to: "cdc", label: "redo log", dashed: true },
      { from: "cdc", to: "bus" },
    ],
  };

  return {
    title: "Brownfield Modernisation Design",
    scenario: "brownfield",
    states: { current, target },
    doc: {
      overview:
        `Modernisation plan for: “${userInput.trim()}”. ` +
        "Strategy: strangler fig. An API gateway fronts the monolith and routes extracted " +
        "capabilities to new services one domain at a time, while CDC keeps legacy Oracle data " +
        "flowing to the new event bus. The monolith is never rewritten big-bang — it shrinks " +
        "until what remains is cheap to retire or leave in place.",
      decisions: [
        ["Strangler fig over big-bang rewrite", "Big-bang rewrites of 800k-LOC systems fail far more often than they succeed. Incremental extraction ships value every quarter and is reversible at every step."],
        ["Gateway-first", "Putting a routing layer in front of the monolith before extracting anything makes every later step a config change, not a client migration."],
        ["Orders as the first extraction", "Highest change-frequency domain with the clearest bounded context — maximum payoff for the pattern-proving slice."],
        ["CDC instead of dual writes", "Debezium tails Oracle redo logs so new services consume legacy data changes without modifying monolith code."],
        ["Per-service data ownership", "Each extracted service gets its own schema in Postgres; no shared-database coupling is carried forward."],
      ],
      nfrs: [
        ["Migration safety", "Every extraction shadow-runs against the monolith before cutover; gateway enables instant rollback per route"],
        ["Availability", "No maintenance-window cutovers; target 99.9% throughout the programme"],
        ["Data integrity", "CDC lag alarmed at > 30 s; weekly reconciliation jobs between Oracle and Postgres"],
        ["Team topology", "One extraction at a time until the platform (CI/CD, observability, bus) is proven"],
      ],
      risks: [
        ["high", "Hidden coupling inside the monolith (shared session state, PL/SQL business logic) can stall extractions — run a 2-week dependency-mapping spike first."],
        ["high", "Oracle licence renewal in-flight: confirm CDC (log mining) is permitted under the current licence terms."],
        ["med", "Team has limited Kafka experience — start with a managed offering (MSK/Confluent) and one topic."],
        ["med", "Strangler programmes lose momentum after the first win — secure exec commitment to a 6-quarter roadmap, not a one-off project."],
        ["low", "SPA rewrite of the JSP UI can trail service extractions; gateway serves both UIs during transition."],
      ],
      phases: [
        ["Phase 0 · 4 wks", "Discovery: dependency map of the monolith, domain boundaries, gateway deployed routing 100% to legacy."],
        ["Phase 1 · Q1", "Extract Orders: new service + Postgres schema, CDC from Oracle, shadow traffic, then cutover /orders/* at the gateway."],
        ["Phase 2 · Q2", "Extract Customers; stand up the event bus as the integration backbone; retire the nightly ETL it replaces."],
        ["Phase 3 · Q3–Q4", "Repeat per domain (catalogue, billing). Begin JSP → SPA migration behind the same gateway."],
        ["Endgame", "Monolith reduced to low-change admin functions: containerise and leave, or retire entirely. Decommission Oracle when last consumer moves."],
      ],
    },
  };
}

function dataPlatformSpec(userInput) {
  const target = {
    zones: [
      { id: "src", label: "Sources" },
      { id: "ingest", label: "Ingestion" },
      { id: "store", label: "Lakehouse" },
      { id: "compute", label: "Processing" },
      { id: "serve", label: "Serving" },
    ],
    nodes: [
      { id: "apps", zone: "src", label: "Product Events", sub: "Clickstream SDK", kind: "client" },
      { id: "dbs", zone: "src", label: "OLTP Databases", sub: "CDC via Debezium", kind: "data" },
      { id: "saas", zone: "src", label: "SaaS Sources", sub: "Salesforce, Stripe…", kind: "external" },
      { id: "kafka", zone: "ingest", label: "Kafka", sub: "Streaming backbone", kind: "async" },
      { id: "elt", zone: "ingest", label: "Batch ELT", sub: "Fivetran/Airbyte", kind: "async" },
      { id: "lake", zone: "store", label: "Lakehouse", sub: "S3 + Iceberg", kind: "data" },
      { id: "flink", zone: "compute", label: "Stream Proc.", sub: "Flink · sessionisation", kind: "app" },
      { id: "dbt", zone: "compute", label: "dbt Models", sub: "Bronze→Silver→Gold", kind: "app" },
      { id: "wh", zone: "serve", label: "Warehouse", sub: "Snowflake/Trino", kind: "data" },
      { id: "bi", zone: "serve", label: "BI + Metrics", sub: "Dashboards, alerts", kind: "client" },
      { id: "rtapi", zone: "serve", label: "Realtime API", sub: "Sub-second features", kind: "app" },
    ],
    edges: [
      { from: "apps", to: "kafka", label: "events" },
      { from: "dbs", to: "kafka", label: "CDC" },
      { from: "saas", to: "elt", dashed: true },
      { from: "kafka", to: "flink" },
      { from: "kafka", to: "lake", label: "raw sink" },
      { from: "elt", to: "lake" },
      { from: "flink", to: "rtapi", label: "features" },
      { from: "flink", to: "lake" },
      { from: "lake", to: "dbt" },
      { from: "dbt", to: "wh" },
      { from: "wh", to: "bi", label: "SQL" },
    ],
  };
  return {
    title: "Realtime Analytics Platform Design",
    scenario: "greenfield",
    states: { target },
    doc: {
      overview:
        `Proposed architecture for: “${userInput.trim()}”. ` +
        "A streaming-first lakehouse: Kafka is the single ingestion backbone, raw data lands in " +
        "open table formats (Iceberg on S3), and the same data serves both sub-second use cases " +
        "(via Flink) and analytical modelling (via dbt into the warehouse). Open formats keep " +
        "compute engines swappable.",
      decisions: [
        ["Streaming-first ingestion", "Batch is a special case of streaming, not vice-versa. One backbone avoids the classic lambda-architecture duplication."],
        ["Open table format (Iceberg)", "Storage decoupled from compute: Trino, Spark, Snowflake can all read the same tables — no warehouse lock-in on raw data."],
        ["dbt for transformation", "Version-controlled, testable SQL models with lineage; analytics engineering as software engineering."],
        ["Buy ingestion connectors", "Fivetran/Airbyte for SaaS sources; connector maintenance is undifferentiated heavy lifting."],
      ],
      nfrs: [
        ["Freshness", "Realtime path < 5 s end-to-end; modelled marts hourly"],
        ["Scale", "Designed for ~50k events/s sustained, 10× burst"],
        ["Governance", "Schema registry mandatory on all topics; PII tagged and masked in Silver layer"],
        ["Cost", "Storage/compute separation; warehouse auto-suspend; ~70% of queries should hit pre-aggregated Gold tables"],
      ],
      risks: [
        ["high", "Schema drift from producers silently breaks pipelines — enforce schema registry compatibility rules from day one."],
        ["med", "Flink operational complexity is real; if sub-second isn't a hard requirement, start with Kafka→lake micro-batching and add Flink later."],
        ["med", "Cost runaway on warehouse compute — set per-team resource monitors before opening access."],
      ],
      phases: [
        ["Phase 1 · Weeks 1–4", "Kafka + schema registry, clickstream SDK, raw events landing in Iceberg."],
        ["Phase 2 · Weeks 5–8", "dbt project + warehouse, first Gold marts, BI dashboards for the top 5 business questions."],
        ["Phase 3 · Weeks 9–14", "CDC from OLTP, SaaS ELT, then the Flink realtime path once batch is trusted."],
      ],
    },
  };
}

/* =====================================================================
   INPUT CLASSIFICATION (mock of the LLM step)
   ===================================================================== */

function detectAddons(text) {
  const t = text.toLowerCase();
  const addons = new Set();
  if (/(payment|checkout|billing|e-?commerce|stripe|subscript)/.test(t)) addons.add("payments");
  if (/\b(ai|ml|llm|gpt|claude|recommendation|rag|chatbot|agent)\b/.test(t)) addons.add("ai");
  if (/(real-?time|websocket|live|chat|collaborat|presence)/.test(t)) addons.add("realtime");
  if (/(mobile|ios|android|app store)/.test(t)) addons.add("mobile");
  if (/(search|elasticsearch|opensearch|full-?text)/.test(t)) addons.add("search");
  return addons;
}

function classify(text) {
  const t = text.toLowerCase();
  if (/(brownfield|legacy|monolith|migrat|moderni[sz]|strangler|mainframe|on-?prem|rewrite|oracle|weblogic|cobol)/.test(t)) return "brownfield";
  if (/(analytics|data platform|clickstream|warehouse|lakehouse|streaming|kafka|etl|pipeline|bi\b)/.test(t)) return "data";
  return "greenfield";
}

/* =====================================================================
   REFINEMENTS (mock of iterative design loop)
   ===================================================================== */

const REFINEMENTS = [
  {
    match: /(terraform|cloud ?formation|\biac\b|infra(structure)? as code|build pack|hand ?-?(off|over)|backlog|jira|adr|provision)/i,
    apply(spec) {
      const nodes = buildableNodes(spec);
      const total = totalCost(spec);
      setTimeout(() => switchTab("build"), 200);
      return (
        `I've opened the **Build** tab with the engineering hand-off pack for this design:\n\n` +
        `• **Terraform** — a reviewed skeleton covering **${nodes.length} provisionable components** (clients, SaaS, and legacy estate are listed but intentionally excluded). TODOs mark where your org's VPC module, state backend, and tagging standards plug in.\n` +
        `• **CloudFormation** — the same components for CFN shops, with gaps flagged.\n` +
        `• **ADRs** — one Architecture Decision Record per decision in the doc, ready to drop into your repo.\n` +
        `• **Backlog** — epics mapped to the delivery phases plus provisioning/implementation stories, downloadable as CSV for Jira import.\n\n` +
        `Indicative run cost for the provisioned estate is **≈ ${fmtCost(total)}/month** at launch scale (the Design Doc has the per-component breakdown).\n\n` +
        `You can also click any single component in the diagram to grab just its spec sheet and IaC snippet.`
      );
    },
  },
  {
    match: /(add|put|include).*(redis|cach)/i,
    apply(spec) {
      const st = spec.states.target;
      if (st.nodes.some(n => n.id === "redis")) return "Redis is already in the design.";
      const dataZone = st.zones.find(z => /data/i.test(z.label)) || st.zones[st.zones.length - 2];
      st.nodes.push({ id: "redis", zone: dataZone.id, label: "Redis", sub: "ElastiCache · cache + sessions", kind: "data" });
      const api = st.nodes.find(n => /api|orders|core/i.test(n.label)) || st.nodes[0];
      st.edges.push({ from: api.id, to: "redis", label: "cache" });
      spec.doc.decisions.push(["Redis as a look-aside cache", "Hot reads and session state move off the primary database; TTL-based invalidation keeps the model simple."]);
      return "Added **Redis (ElastiCache)** to the data tier as a look-aside cache for hot reads and session state, wired from the API. I also recorded the decision and its invalidation strategy in the design doc.\n\nRule of thumb: add it when p95 read latency or DB CPU says so — it's cheap insurance here given the read-heavy profile.";
    },
  },
  {
    match: /(add|include).*(cdn|cloudfront|edge cach)/i,
    apply(spec) {
      const st = spec.states.target;
      if (st.nodes.some(n => n.id === "cdn")) return "A CDN is already at the edge of this design.";
      const edgeZone = st.zones.find(z => /edge/i.test(z.label)) || st.zones[1];
      st.nodes.unshift({ id: "cdn", zone: edgeZone.id, label: "CDN + WAF", sub: "CloudFront", kind: "edge" });
      const client = st.nodes.find(n => n.kind === "client");
      if (client) st.edges.unshift({ from: client.id, to: "cdn", label: "HTTPS" });
      return "Added a **CDN with WAF** at the edge. Static assets and cacheable API responses now terminate there, which also gives you DDoS absorption and TLS at the perimeter.";
    },
  },
  {
    match: /(multi[- ]?region|disaster recovery|\bdr\b|high availability|\bha\b|failover)/i,
    apply(spec) {
      const st = spec.states.target;
      if (st.nodes.some(n => n.id === "dr")) return "Multi-region posture is already in the design.";
      const dataZone = st.zones.find(z => /data/i.test(z.label)) || st.zones[st.zones.length - 1];
      st.nodes.push({ id: "dr", zone: dataZone.id, label: "Region B (warm)", sub: "Cross-region replica", kind: "ops" });
      const db = st.nodes.find(n => n.kind === "data");
      if (db) st.edges.push({ from: db.id, to: "dr", label: "async repl.", dashed: true });
      spec.doc.risks.push(["low", "Warm-standby DR adds ~30–40% to data-tier cost; failover drills must run quarterly or the runbook rots."]);
      spec.doc.decisions.push(["Warm standby over active-active", "Active-active doubles complexity (conflict resolution, global routing) for an RTO most products don't need. Warm standby gives RTO ≈ 15 min, RPO ≈ 1 min at a fraction of the effort."]);
      return "Upgraded the design to a **warm-standby multi-region** posture: async cross-region replication on the data tier, with DNS failover.\n\nI deliberately chose warm standby over active-active — RTO ≈ 15 min / RPO ≈ 1 min covers most SLAs without the conflict-resolution complexity. The trade-off is recorded in the design doc.";
    },
  },
  {
    match: /(risk|concern|worr|what could go wrong|gotcha)/i,
    apply(spec) {
      const lines = spec.doc.risks.map(([sev, txt]) => `• **${sev.toUpperCase()}** — ${txt}`).join("\n");
      return "Here are the key risks I'm tracking for this design (also in the Design Doc tab):\n\n" + lines;
    },
  },
  {
    match: /(remove|drop|delete)\s+(the\s+)?(\w[\w\s-]*)/i,
    apply(spec, m) {
      const needle = m[3].trim().toLowerCase();
      const st = spec.states.target;
      const node = st.nodes.find(n => n.label.toLowerCase().includes(needle) || n.id === needle);
      if (!node) return `I couldn't find a component matching “${m[3].trim()}” in the current design. Check the node names in the Diagram tab.`;
      st.nodes = st.nodes.filter(n => n.id !== node.id);
      st.edges = st.edges.filter(e => e.from !== node.id && e.to !== node.id);
      return `Removed **${node.label}** and its connections from the design. If anything depended on it, the diagram will show the gap — tell me what should absorb its responsibilities.`;
    },
  },
];

/* =====================================================================
   DIAGRAM RENDERER  (spec → SVG, simple layered layout)
   ===================================================================== */

const NODE_W = 168, NODE_H = 58, V_GAP = 26, ZONE_PAD = 18, ZONE_GAP = 34, ZONE_TOP = 40;

function layout(state) {
  const byZone = new Map(state.zones.map(z => [z.id, []]));
  for (const n of state.nodes) (byZone.get(n.zone) || byZone.set(n.zone, []).get(n.zone)).push(n);

  const maxCount = Math.max(1, ...[...byZone.values()].map(a => a.length));
  const zoneH = ZONE_TOP + maxCount * NODE_H + (maxCount - 1) * V_GAP + ZONE_PAD;
  const zoneW = NODE_W + ZONE_PAD * 2;

  const pos = new Map();
  const zoneBoxes = [];
  let x = 10;
  for (const z of state.zones) {
    const nodes = byZone.get(z.id) || [];
    zoneBoxes.push({ ...z, x, y: 10, w: zoneW, h: zoneH });
    const stackH = nodes.length * NODE_H + (nodes.length - 1) * V_GAP;
    let y = 10 + ZONE_TOP + (zoneH - ZONE_TOP - ZONE_PAD - stackH) / 2;
    for (const n of nodes) {
      pos.set(n.id, { x: x + ZONE_PAD, y, w: NODE_W, h: NODE_H, node: n });
      y += NODE_H + V_GAP;
    }
    x += zoneW + ZONE_GAP;
  }
  return { pos, zoneBoxes, width: x - ZONE_GAP + 10, height: zoneH + 20 };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderSVG(state, { animate = true } = {}) {
  const { pos, zoneBoxes, width, height } = layout(state);
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" font-family="sans-serif">`;
  out += `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#5a6580"/></marker></defs>`;

  // zones
  for (const z of zoneBoxes) {
    out += `<rect class="zone-rect" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="14"/>`;
    out += `<text class="zone-label" x="${z.x + 16}" y="${z.y + 24}">${esc(z.label)}</text>`;
  }

  // edges
  let i = 0;
  for (const e of state.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const forward = b.x >= a.x + a.w;
    const backward = a.x >= b.x + b.w;
    let x1, y1, x2, y2;
    if (forward)      { x1 = a.x + a.w; y1 = a.y + a.h / 2; x2 = b.x;       y2 = b.y + b.h / 2; }
    else if (backward){ x1 = a.x;       y1 = a.y + a.h / 2; x2 = b.x + b.w; y2 = b.y + b.h / 2; }
    else { // same column: connect vertically
      const down = b.y > a.y;
      x1 = a.x + a.w / 2; y1 = down ? a.y + a.h : a.y;
      x2 = b.x + b.w / 2; y2 = down ? b.y : b.y + b.h;
    }
    const mx = (x1 + x2) / 2;
    const path = (forward || backward)
      ? `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
      : `M ${x1} ${y1} L ${x2} ${y2}`;
    const delay = animate ? ` style="animation-delay:${0.35 + i * 0.05}s"` : "";
    out += `<g class="edge-g"${delay}>`;
    out += `<path class="edge-path${e.dashed ? " dashed" : ""}" d="${path}" marker-end="url(#arrow)"/>`;
    if (e.label) {
      const lx = (x1 + x2) / 2, ly = (y1 + y2) / 2;
      const w = e.label.length * 5.4 + 10;
      out += `<rect class="edge-label-bg" x="${lx - w / 2}" y="${ly - 9}" width="${w}" height="15" rx="4"/>`;
      out += `<text class="edge-label" x="${lx}" y="${ly + 2.5}" text-anchor="middle">${esc(e.label)}</text>`;
    }
    out += `</g>`;
    i++;
  }

  // nodes
  let j = 0;
  for (const { x, y, w, h, node } of pos.values()) {
    const c = KIND_COLORS[node.kind] || KIND_COLORS.app;
    const delay = animate ? ` style="animation-delay:${j * 0.06}s"` : "";
    out += `<g class="node-g clickable" data-node="${esc(node.id)}"${delay}>`;
    out += `<rect class="node-rect" x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${c.fill}" stroke="${c.stroke}"/>`;
    out += `<text class="node-label" x="${x + 13}" y="${y + 24}">${esc(node.label)}</text>`;
    out += `<text class="node-sub" x="${x + 13}" y="${y + 41}">${esc(node.sub || "")}</text>`;
    out += `<text class="node-badge" x="${x + w - 10}" y="${y + 16}" text-anchor="end" fill="${c.stroke}">${esc(c.badge)}</text>`;
    out += `</g>`;
    j++;
  }

  out += `</svg>`;
  return out;
}

/* =====================================================================
   DESIGN DOC RENDERER
   ===================================================================== */

function renderDoc(spec) {
  const d = spec.doc;
  const el = document.getElementById("doc-host");
  const sevClass = { high: "risk-high", med: "risk-med", low: "risk-low" };
  const sevLabel = { high: "HIGH", med: "MED", low: "LOW" };

  let html = `<h1>${esc(spec.title)}</h1>`;
  html += `<div class="doc-meta">Generated by ArchitectAI (mockup) · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · v${spec._version || 1}</div>`;
  html += `<h2>1. Overview</h2><p>${esc(d.overview)}</p>`;

  html += `<h2>2. Key Architecture Decisions</h2><table><tr><th>Decision</th><th>Rationale</th></tr>`;
  for (const [t, r] of d.decisions) html += `<tr><td>${esc(t)}</td><td>${esc(r)}</td></tr>`;
  html += `</table>`;

  html += `<h2>3. Components &amp; Indicative Run Cost</h2>`;
  html += `<p>Click any component in the diagram for its full spec sheet and IaC snippet. Costs are order-of-magnitude monthly estimates at launch scale, excluding egress and people.</p>`;
  html += `<table><tr><th>Component</th><th>Notes</th><th style="text-align:right">Est. / month</th></tr>`;
  for (const n of spec.states.target.nodes) {
    const m = metaFor(n);
    html += `<tr><td>${esc(n.label)}</td><td>${esc(n.sub || "")}</td><td style="text-align:right">${esc(fmtCost(m.cost))}</td></tr>`;
  }
  html += `<tr class="cost-total"><td>Total (provisioned)</td><td></td><td style="text-align:right">≈ ${esc(fmtCost(totalCost(spec)))}</td></tr>`;
  html += `</table>`;

  html += `<h2>4. Non-Functional Requirements</h2><table><tr><th>Quality</th><th>Target / Approach</th></tr>`;
  for (const [q, v] of d.nfrs) html += `<tr><td>${esc(q)}</td><td>${esc(v)}</td></tr>`;
  html += `</table>`;

  html += `<h2>5. Risks &amp; Mitigations</h2><ul style="list-style:none;margin-left:0">`;
  for (const [sev, txt] of d.risks) {
    html += `<li style="margin-bottom:9px"><span class="risk-tag ${sevClass[sev]}">${sevLabel[sev]}</span>${esc(txt)}</li>`;
  }
  html += `</ul>`;

  const phasesTitle = spec.scenario === "brownfield" ? "6. Migration Roadmap" : "6. Delivery Plan";
  html += `<h2>${phasesTitle}</h2>`;
  for (const [t, desc] of d.phases) {
    html += `<div class="phase"><div class="phase-title"><span>◆</span>${esc(t)}</div><p>${esc(desc)}</p></div>`;
  }

  el.innerHTML = html;
}

/* =====================================================================
   CHAT / APP STATE
   ===================================================================== */

const $ = id => document.getElementById(id);
const chatMessages = $("chat-messages");
const chatScroll = $("chat-scroll");

let activeSpec = null;
let activeState = "target";
let busy = false;

const STARTERS = [
  { label: "<b>Greenfield</b> · B2B SaaS e-commerce platform on AWS, ~50k users, Stripe payments", text: "Design a greenfield B2B SaaS e-commerce platform on AWS for around 50k users, with Stripe payments and a small team." },
  { label: "<b>Brownfield</b> · Migrate a legacy Java monolith on Oracle to microservices", text: "We run a legacy Java monolith (~800k LOC on WebLogic + Oracle). Plan an incremental migration to microservices without a big-bang rewrite." },
  { label: "<b>Data</b> · Realtime analytics platform for clickstream events", text: "Design a realtime analytics platform ingesting clickstream events at ~50k events/sec, with both dashboards and sub-second feature serving." },
];

const FOLLOWUPS = [
  { label: "Generate the build pack", text: "Generate the Terraform and build pack for this design" },
  { label: "Add a Redis cache", text: "Add a Redis cache" },
  { label: "Make it multi-region", text: "Make it multi-region with disaster recovery" },
  { label: "What are the main risks?", text: "What are the main risks of this design?" },
];

function addMsg(role, html) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  wrap.innerHTML = `
    <div class="msg-avatar">${role === "user" ? "Y" : "A"}</div>
    <div class="msg-body">
      <div class="msg-name">${role === "user" ? "You" : "ArchitectAI"}</div>
      <div class="msg-text"></div>
    </div>`;
  chatMessages.appendChild(wrap);
  const textEl = wrap.querySelector(".msg-text");
  if (html != null) textEl.innerHTML = html;
  scrollChat();
  return wrap;
}

function scrollChat() { chatScroll.scrollTop = chatScroll.scrollHeight; }

function mdLite(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/\n/g, "<br>");
}

/* typewriter */
function typeOut(el, text, speed = 9) {
  return new Promise(resolve => {
    const words = text.split(/(\s+)/);
    let i = 0;
    el.innerHTML = `<span class="t"></span><span class="cursor"></span>`;
    const t = el.querySelector(".t");
    const timer = setInterval(() => {
      if (i >= words.length) {
        clearInterval(timer);
        el.innerHTML = mdLite(text);
        scrollChat();
        resolve();
        return;
      }
      t.innerHTML = mdLite(words.slice(0, ++i).join(""));
      scrollChat();
    }, speed);
  });
}

/* fake agent steps */
function runSteps(container, labels) {
  return new Promise(resolve => {
    const box = document.createElement("div");
    box.className = "steps";
    container.insertBefore(box, container.querySelector(".msg-text"));
    let i = 0;
    function next() {
      if (i > 0) {
        const prev = box.children[i - 1];
        prev.classList.remove("running");
        prev.classList.add("done");
      }
      if (i >= labels.length) { resolve(); return; }
      const s = document.createElement("div");
      s.className = "step running";
      s.innerHTML = `<span class="dot"></span><span>${esc(labels[i])}</span>`;
      box.appendChild(s);
      scrollChat();
      i++;
      setTimeout(next, 450 + Math.random() * 450);
    }
    next();
  });
}

/* =====================================================================
   RESPONSES
   ===================================================================== */

function summaryFor(spec, kind, addons) {
  const n = spec.states.target.nodes.length;
  if (kind === "brownfield") {
    return (
      "This is a **brownfield modernisation**, so I've designed it as a strangler-fig programme rather than a rewrite.\n\n" +
      "**Approach:** an API gateway goes in front of the monolith first (zero behaviour change), then domains are extracted one at a time — Orders first, since it has the clearest boundary and highest change rate. Debezium CDC taps Oracle's redo logs so new services get legacy data without touching monolith code. Every cutover is a gateway routing change, instantly reversible.\n\n" +
      "Use the **Current state / Target state** toggle above the diagram to compare. The Design Doc has the full decision log, risk register (note the Oracle licensing flag), an indicative run-cost breakdown, and a 6-quarter migration roadmap.\n\n" +
      "When you're ready to mobilise: **click any component** for its spec sheet and IaC snippet, or open the **Build** tab for the full hand-off pack — Terraform for the new estate, ADRs, and a phased backlog for Jira.\n\n" +
      "What would you like to pressure-test — the extraction order, the data strategy, or the team topology?"
    );
  }
  if (kind === "data") {
    return (
      "I've designed a **streaming-first lakehouse** — one ingestion backbone (Kafka) feeding both the realtime path (Flink) and the analytical path (Iceberg → dbt → warehouse), so you avoid maintaining two parallel pipelines.\n\n" +
      "Key call: open table formats on S3 mean your raw data is never locked into one warehouse vendor. The Design Doc covers freshness targets, governance (schema registry is non-negotiable), run costs, and a phased rollout that ships dashboards before the harder realtime path.\n\n" +
      "**Click any component** for sizing and its Terraform snippet, or open the **Build** tab for the full pack (IaC, ADRs, backlog).\n\n" +
      "Want me to adjust for a different scale, add ML feature serving, or talk through the Flink-vs-micro-batch trade-off?"
    );
  }
  const extras = [];
  if (addons.has("payments")) extras.push("a PCI-isolated payments service fronting Stripe");
  if (addons.has("ai")) extras.push("an AI service with vector search and an LLM provider behind a guardrail layer");
  if (addons.has("realtime")) extras.push("a dedicated WebSocket gateway for realtime features");
  if (addons.has("mobile")) extras.push("a mobile client sharing the same API gateway");
  if (addons.has("search")) extras.push("OpenSearch with async indexing");
  return (
    `Here's a first-pass design — **${n} components** across clients, edge, application, data, and async tiers.\n\n` +
    "**Shape:** a modular monolith on managed AWS services. At this stage, one well-structured deployable beats microservices — you get speed now and clean seams (gateway, event bus) to split along later." +
    (extras.length ? `\n\nFrom your description I also included ${extras.join("; ")}.` : "") +
    "\n\nThe **Design Doc** tab has the decision log, NFR targets, risks, an indicative run-cost table, and a 12-week delivery plan. **Click any component in the diagram** for its spec sheet, sizing, cost, and Terraform/CloudFormation snippet — and the **Build** tab has the full engineering hand-off pack (IaC, ADRs, Jira-ready backlog).\n\nRefine it in plain language — e.g. *“add a Redis cache”*, *“make it multi-region”* — or say *“generate the build pack”*."
  );
}

async function handleInput(text) {
  if (busy) return;
  busy = true;
  $("btn-send").disabled = true;
  $("chat-empty").style.display = "none";
  $("followup-chips").innerHTML = "";

  addMsg("user", esc(text));
  const aiMsg = addMsg("ai", "");
  const body = aiMsg.querySelector(".msg-body");
  const textEl = aiMsg.querySelector(".msg-text");

  // refinement of an existing design?
  if (activeSpec) {
    for (const r of REFINEMENTS) {
      const m = text.match(r.match);
      if (m) {
        await runSteps(body, ["Reviewing current design", "Applying change", "Updating diagram & doc"]);
        const reply = r.apply(activeSpec, m);
        activeSpec._version = (activeSpec._version || 1) + 1;
        renderAll();
        await typeOut(textEl, reply);
        showFollowups();
        done();
        return;
      }
    }
  }

  // new design
  const kind = classify(text);
  const addons = detectAddons(text);
  const steps =
    kind === "brownfield"
      ? ["Parsing constraints & legacy estate", "Mapping current-state architecture", "Selecting modernisation strategy", "Drafting target state & migration plan"]
      : ["Parsing requirements", "Identifying components & tiers", "Selecting reference architecture", "Drafting diagram & design doc"];

  await runSteps(body, steps);

  activeSpec =
    kind === "brownfield" ? brownfieldSpec(text)
    : kind === "data" ? dataPlatformSpec(text)
    : greenfieldSpec(text, addons);
  activeSpec._version = 1;
  activeState = "target";

  renderAll();
  await typeOut(textEl, summaryFor(activeSpec, kind, addons));
  showFollowups();
  done();
}

function showFollowups() {
  const host = $("followup-chips");
  host.innerHTML = "";
  for (const f of FOLLOWUPS) {
    const b = document.createElement("button");
    b.className = "chip";
    b.innerHTML = f.label;
    b.onclick = () => { submitText(f.text); };
    host.appendChild(b);
  }
}

function done() {
  busy = false;
  $("btn-send").disabled = false;
  $("chat-text").focus();
}

/* =====================================================================
   WORKSPACE RENDERING
   ===================================================================== */

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "design";
}

function renderAll() {
  if (!activeSpec) return;
  $("ws-placeholder").style.display = "none";
  $("url-text").textContent = "architectai.app/" + slugify(activeSpec.title);

  // state toggle for brownfield
  const toggle = $("state-toggle");
  if (activeSpec.states.current) {
    toggle.hidden = false;
    toggle.querySelectorAll(".state-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.state === activeState));
  } else {
    toggle.hidden = true;
    activeState = "target";
  }

  const state = activeSpec.states[activeState] || activeSpec.states.target;
  $("diagram-host").innerHTML = renderSVG(state);
  $("diagram-hint").hidden = false;
  closeDrawer();
  renderDoc(activeSpec);
  renderBuild();
  $("spec-host").textContent = JSON.stringify(
    { title: activeSpec.title, scenario: activeSpec.scenario, version: activeSpec._version, states: activeSpec.states },
    null, 2);
}

/* ----- node spec drawer ----- */

let drawerIacMode = "tf";

function openDrawer(nodeId) {
  const state = activeSpec.states[activeState] || activeSpec.states.target;
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const m = metaFor(node);
  const c = KIND_COLORS[node.kind] || KIND_COLORS.app;

  document.querySelectorAll("#diagram-host .node-g").forEach(g =>
    g.classList.toggle("selected", g.dataset.node === nodeId));

  const badge = $("drawer-badge");
  badge.textContent = c.badge;
  badge.style.color = c.stroke;
  badge.style.borderColor = c.stroke;
  $("drawer-title").textContent = node.label;
  $("drawer-sub").textContent = node.sub || "";

  let html = `<p>${esc(m.desc)}</p>`;
  html += `<h4>Spec</h4><table class="kv">`;
  for (const [k, v] of Object.entries(m.specs)) html += `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
  html += `</table>`;

  html += `<h4>Indicative cost</h4><div class="cost-line"><span class="cost-num">${esc(fmtCost(m.cost))}</span><span class="cost-per">${m.cost === null ? (node.kind === "legacy" ? "existing estate" : "usage-based / external") : "per month, launch scale"}</span></div>`;

  if (m.tf) {
    html += `<h4>Infrastructure as code</h4>`;
    html += `<div class="iac-tabs">
      <button class="iac-tab ${drawerIacMode === "tf" ? "active" : ""}" data-iac="tf">Terraform</button>
      <button class="iac-tab ${drawerIacMode === "cfn" ? "active" : ""}" data-iac="cfn" ${m.cfn ? "" : "disabled title='No CFN snippet for this component in the mockup'"}>CloudFormation</button>
    </div>`;
    const code = drawerIacMode === "cfn" && m.cfn ? m.cfn : m.tf;
    html += `<pre class="codeblock" id="drawer-code">${esc(code)}</pre>`;
    html += `<div class="drawer-iac-actions">
      <button class="btn btn-ghost btn-sm" id="drawer-copy">Copy</button>
      <button class="btn btn-sm btn-primary" id="drawer-dl">Download ${drawerIacMode === "cfn" && m.cfn ? node.id + ".yaml" : node.id + ".tf"}</button>
    </div>`;
  } else {
    html += `<h4>Infrastructure as code</h4><p style="color:var(--text-dim);font-size:12.5px">No IaC for this component — ${node.kind === "client" ? "it's a client application with its own delivery pipeline." : node.kind === "legacy" ? "it's existing estate being strangled, not rebuilt." : "it's an external/SaaS dependency configured in its own console or provider."}</p>`;
  }

  $("drawer-body").innerHTML = html;
  $("drawer").hidden = false;

  const codeEl = $("drawer-code");
  document.querySelectorAll(".iac-tab").forEach(b => b.onclick = () => {
    if (b.disabled) return;
    drawerIacMode = b.dataset.iac;
    openDrawer(nodeId);
  });
  const copyBtn = $("drawer-copy");
  if (copyBtn) copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(codeEl.textContent); toast("Snippet copied"); }
    catch { toast("Clipboard unavailable"); }
  };
  const dlBtn = $("drawer-dl");
  if (dlBtn) dlBtn.onclick = () => {
    const isCfn = drawerIacMode === "cfn" && m.cfn;
    downloadText(codeEl.textContent, node.id + (isCfn ? ".yaml" : ".tf"), isCfn ? "text/yaml" : "text/plain");
  };
}

function closeDrawer() {
  $("drawer").hidden = true;
  document.querySelectorAll("#diagram-host .node-g.selected").forEach(g => g.classList.remove("selected"));
}

/* ----- build pane ----- */

let activeArtifact = "terraform";

const ARTIFACTS = {
  terraform: {
    note: spec => `Terraform skeleton for the target state — ${buildableNodes(spec).length} provisionable components. TODOs mark where your org's state backend, VPC module, and tagging standards plug in. Clients, SaaS, and legacy estate are intentionally excluded and listed at the bottom.`,
    text: genTerraform, file: "main.tf", mime: "text/plain", code: true,
  },
  cloudformation: {
    note: () => `CloudFormation rendering of the same design for CFN shops. Components without a CFN mapping in this mockup are flagged as TODO — the Terraform artifact is the complete one.`,
    text: genCloudFormation, file: "template.yaml", mime: "text/yaml", code: true,
  },
  adr: {
    note: () => `One Architecture Decision Record per decision in the design doc, in the standard Context / Decision / Consequences format. Drop into your repo under /docs/adr and review in the next architecture forum.`,
    text: genADRs, file: "adrs.md", mime: "text/markdown", code: true,
  },
  backlog: {
    note: () => `Delivery backlog derived from the phased plan: one epic per phase, stories for provisioning and implementation. Download as CSV for Jira import (Type, Summary, Description, Epic, Estimate).`,
    text: genBacklogCSV, file: "backlog.csv", mime: "text/csv", code: false,
  },
};

function renderBuild() {
  if (!activeSpec) return;
  const art = ARTIFACTS[activeArtifact];
  $("build-note").textContent = art.note(activeSpec);
  document.querySelectorAll(".artifact-tab").forEach(b =>
    b.classList.toggle("active", b.dataset.artifact === activeArtifact));

  if (art.code) {
    $("build-host").hidden = false;
    $("backlog-host").hidden = true;
    $("build-host").textContent = art.text(activeSpec);
  } else {
    $("build-host").hidden = true;
    $("backlog-host").hidden = false;
    const rows = genBacklogRows(activeSpec);
    let html = `<table><tr><th>Type</th><th>Summary</th><th>Description</th><th>Epic</th><th>Est.</th></tr>`;
    for (const [type, sum, desc, epic, est] of rows) {
      html += `<tr><td><span class="bk-type ${type === "Epic" ? "bk-epic" : "bk-story"}">${esc(type)}</span></td><td>${esc(sum)}</td><td>${esc(desc)}</td><td>${esc(epic)}</td><td>${esc(est)}</td></tr>`;
    }
    $("backlog-host").innerHTML = html + `</table>`;
  }
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function switchTab(name) {
  document.querySelectorAll(".ws-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".ws-pane").forEach(p => p.classList.toggle("active", p.id === "pane-" + name));
}

/* =====================================================================
   WIRING
   ===================================================================== */

function submitText(text) {
  if (!text.trim() || busy) return;
  $("chat-text").value = "";
  autosize();
  handleInput(text.trim());
}

$("chat-form").addEventListener("submit", e => {
  e.preventDefault();
  submitText($("chat-text").value);
});

$("chat-text").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitText($("chat-text").value);
  }
});

function autosize() {
  const t = $("chat-text");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 120) + "px";
}
$("chat-text").addEventListener("input", autosize);

// starter chips
for (const s of STARTERS) {
  const b = document.createElement("button");
  b.className = "chip";
  b.innerHTML = s.label;
  b.onclick = () => submitText(s.text);
  $("starter-chips").appendChild(b);
}

// tabs
$("ws-tabs").addEventListener("click", e => {
  const btn = e.target.closest(".ws-tab");
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

// diagram node click → spec drawer
$("pane-diagram").addEventListener("click", e => {
  const g = e.target.closest(".node-g[data-node]");
  if (g && activeSpec) { openDrawer(g.dataset.node); return; }
});
$("drawer-close").addEventListener("click", closeDrawer);

// build artifacts
$("artifact-tabs").addEventListener("click", e => {
  const btn = e.target.closest(".artifact-tab");
  if (!btn) return;
  activeArtifact = btn.dataset.artifact;
  renderBuild();
});

$("btn-dl-artifact").addEventListener("click", () => {
  if (!activeSpec) return toast("No design yet — describe a system first.");
  const art = ARTIFACTS[activeArtifact];
  downloadText(art.text(activeSpec), art.file, art.mime);
});

$("btn-copy-artifact").addEventListener("click", async () => {
  if (!activeSpec) return toast("No design yet — describe a system first.");
  try {
    await navigator.clipboard.writeText(ARTIFACTS[activeArtifact].text(activeSpec));
    toast(ARTIFACTS[activeArtifact].file + " copied to clipboard");
  } catch { toast("Clipboard unavailable"); }
});

// state toggle
$("state-toggle").addEventListener("click", e => {
  const btn = e.target.closest(".state-btn");
  if (!btn || !activeSpec) return;
  activeState = btn.dataset.state;
  renderAll();
});

// reset everything back to a blank design
function resetDesign() {
  activeSpec = null;
  chatMessages.innerHTML = "";
  $("chat-empty").style.display = "";
  $("followup-chips").innerHTML = "";
  $("ws-placeholder").style.display = "";
  $("diagram-host").innerHTML = "";
  $("diagram-hint").hidden = true;
  $("url-text").textContent = "architectai.app/new";
  $("doc-host").innerHTML = "";
  $("spec-host").textContent = "";
  $("build-host").textContent = "";
  $("build-note").textContent = "";
  $("backlog-host").innerHTML = "";
  $("state-toggle").hidden = true;
  activeArtifact = "terraform";
  document.querySelectorAll(".artifact-tab").forEach(b =>
    b.classList.toggle("active", b.dataset.artifact === "terraform"));
  closeDrawer();
  switchTab("diagram");
}

// landing ↔ app transitions
function goHome() {
  resetDesign();
  $("app").hidden = true;
  $("landing").hidden = false;
  $("landing-text").value = "";
  landingAutosize();
  $("landing-text").focus();
}

function enterApp(text) {
  if (!text.trim()) return;
  $("landing").hidden = true;
  $("app").hidden = false;
  submitText(text.trim());
}

$("btn-new").addEventListener("click", goHome);
$("brand-home").addEventListener("click", goHome);

// landing prompt
function landingAutosize() {
  const t = $("landing-text");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}
$("landing-text").addEventListener("input", landingAutosize);
$("landing-form").addEventListener("submit", e => {
  e.preventDefault();
  enterApp($("landing-text").value);
});
$("landing-text").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    enterApp($("landing-text").value);
  }
});

// hero suggestion chips (same scenarios as the in-app starters)
for (const s of STARTERS) {
  const b = document.createElement("button");
  b.className = "chip";
  b.innerHTML = s.label;
  b.onclick = () => enterApp(s.text);
  $("hero-chips").appendChild(b);
}
$("landing-text").focus();

// exports
$("btn-svg").addEventListener("click", () => {
  if (!activeSpec) return toast("No design yet — describe a system first.");
  const state = activeSpec.states[activeState] || activeSpec.states.target;
  // inline the styles so the standalone SVG renders correctly
  const css = `
    .zone-rect{fill:rgba(0,0,0,0.02);stroke:#cbd2e0;}
    .zone-label{fill:#6b7385;font-size:11px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;}
    .node-label{fill:#1d2333;font-size:12.5px;font-weight:600;}
    .node-sub{fill:#6b7385;font-size:10.5px;}
    .node-badge{font-size:9px;font-weight:700;letter-spacing:.8px;}
    .edge-path{fill:none;stroke:#8a93a8;stroke-width:1.5;}
    .edge-path.dashed{stroke-dasharray:5 4;}
    .edge-label-bg{fill:#ffffff;opacity:.92;}
    .edge-label{fill:#6b7385;font-size:10px;}
    .node-g,.edge-g{opacity:1;}`;
  let svg = renderSVG(state, { animate: false });
  svg = svg.replace("<defs>", `<style>${css}</style><rect width="100%" height="100%" fill="#ffffff"/><defs>`);
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "architectai-design.svg";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("btn-json").addEventListener("click", async () => {
  if (!activeSpec) return toast("No design yet — describe a system first.");
  try {
    await navigator.clipboard.writeText($("spec-host").textContent);
    toast("Spec JSON copied to clipboard");
  } catch {
    toast("Clipboard unavailable — use the Spec tab to copy manually.");
  }
});

// feedback button — only shown once FEEDBACK_URL is set
if (FEEDBACK_URL) {
  const fb = $("btn-feedback");
  fb.hidden = false;
  fb.addEventListener("click", () => window.open(FEEDBACK_URL, "_blank", "noopener"));
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}
