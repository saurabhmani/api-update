# Product A — Security Operations (Phase 5)

## Checks

| Check | Severity | Description |
|-------|----------|-------------|
| `secret_session_secret` | critical | SESSION_SECRET present and ≥ 16 chars |
| `credential_*` | info/critical | Provider keys not placeholders |
| `configuration_integrity` | warning | Signal engine config version valid |
| `parameter_integrity` | critical | Active adaptive parameter hash valid |
| `audit_trail_available` | info | Adaptive audit entries accessible |
| `permission_validation` | warning | Admin role verified for ops endpoints |

## Usage

```typescript
import { validateSecurityOperations } from '@/lib/operations/securityOperations';

const result = validateSecurityOperations({ generatedAt });
```

## Operational Rules

1. Never commit `.env*` files (see `.gitignore`)
2. Rotate secrets per `docs/security/secrets-rotation.md`
3. Ops APIs require session authentication
4. Parameter integrity verified before promotion (Phase 4) and deployment (Phase 5)
5. Placeholder credentials (`changeme`, `placeholder`) fail validation

## Deployment Gate

`validate:deployment` includes `session_secret` as a blocking check.
