# Destination Vancouver Policy Baseline (Captured from user-provided text)

Effective date captured: January 9, 2026

This file captures the operational rules implemented in this repo based on the pasted:

- `AI Driven Tools Policy`
- `Data Classification Policy`

## AI Tool Type

- Runtime is treated as `Type B` AI tool behavior.
- Type B allows broader usage than Type A, but does not allow Restricted data.

## Data Classification Rules

- Allowed:
  - `Public`
  - `Internal or Confidential`
- Blocked:
  - `Restricted`

## Prohibited Uses

- Illegal activity
- Rights infringement
- Bullying, harassment, discrimination
- Deception/manipulation/impersonation
- Decisions requiring professional judgment
- Employment decisions (hiring, promotion, discipline, termination, etc.)

## Output Review Requirements

Outputs must be reviewed for:

- Bias/offensive/discriminatory content
- Sensitive data leakage
- Inaccuracy/hallucination/misleading claims
- Verification against trusted sources before business reliance

## Monitoring and Audit

- The runtime keeps trace logs by session (`runs/<session_id>/...`) for oversight and audit.

## Notes

- This baseline is a technical implementation summary, not a replacement for official policy text.
