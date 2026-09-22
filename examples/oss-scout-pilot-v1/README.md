# oss-scout-pilot-v1 — slot 01 (parent task payload)

Prepared 2026-09-22. State: **drafted** (not posted). The payload in
`slot-01.task.json` is the exact body for `POST /v1/tasks` and validates
against `CreateTaskSchema` (title 63/200, description 3900/10000,
expected_output 610/2000, bounty `2000000` atomic = 2.00 USDC on `eip155:8453`).

## Why it was not posted from the trial run

- No Hans credentials were available: the CLI reads only `~/.basedagents/keys/*-keypair.json`
  or `--keypair`, the MCP server reads `BASEDAGENTS_KEYPAIR_PATH` / `BASEDAGENTS_AGENT_ID`
  + `BASEDAGENTS_PRIVATE_KEY_HEX` + `BASEDAGENTS_PUBLIC_KEY_B58`; none existed and no
  BasedAgents MCP server was connected. `POST /v1/tasks` answered `401 unauthorized`.
- Escrow is enabled on the registry, so a 2.00 USDC bounty additionally needs an
  EIP-3009 `PAYMENT-SIGNATURE` from a Base wallet holding ≥ 2.00 USDC. No wallet
  signer was available, and Hans's wallet on record is the placeholder
  `0x1234567890abcdef1234567890abcdef12345678`.

## Not natively supported (stated in the copy instead)

- Campaign / slot tag: no tag field → description footer `campaign: oss-scout-pilot-v1 · slot: 01`.
- 72 h claim-to-delivery window and 14-day unclaimed expiry: no deadline fields → stated in copy;
  the sponsor enforces them by `POST /v1/tasks/:id/cancel` (escrow refunds).
- Idempotency: none on the body. Escrow's `409 authorization_reused` is keyed on the deposit
  nonce only. Before any retry, search the board for the footer string.

## How to post (Hans)

```bash
# 1. First call answers 402 + PAYMENT-REQUIRED (escrow deposit challenge), nothing is written.
npx basedagents tasks post --keypair <hans-keypair.json> \
  --title "$(node -p 'require("./slot-01.task.json").title')" \
  --description "$(node -p 'require("./slot-01.task.json").description')" \
  --category research --capabilities "research, code" \
  --expected-output "$(node -p 'require("./slot-01.task.json").expected_output')" \
  --bounty 2.00
# 2. Sign accepts[0] (transfer of 2000000 atomic USDC to the escrow wallet, validBefore ≤ now+3600s)
#    with an x402 v2 signer, then rerun the SAME command with --payment-signature <base64>.
# 3. Read back: npx basedagents task <task_id>  → verify title, bounty 2.00, creator Hans,
#    status open, escrow.status funded, claimable true, and the campaign footer.
```

## Sponsor's next action when the scout delivers

1. `GET /v1/tasks/:id` → review the delivered JSON against the acceptance list in the copy.
2. `POST /v1/tasks/:id/accept` (or `revision` with a note, max 3 rounds; `dispute` freezes auto-accept).
3. On accept the registry releases the escrow: `payment_status: settled`, `escrow.status: released`.
4. Post the 1.00 USDC child task (`1000000` atomic) from the sponsor account using the delivered spec.
