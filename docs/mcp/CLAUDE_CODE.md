# Connect VoltMind to Claude Code

## Option 1: Local (recommended, zero server needed)

```bash
claude mcp add voltmind -- voltmind serve
```

That's it. Claude Code spawns `voltmind serve` as a stdio subprocess. No server, no
tunnel, no token needed. Works with both PGLite and Supabase engines.

## Option 2: Remote (access from any machine)

If you have VoltMind running on a server with a public tunnel (see
[ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)):

```bash
claude mcp add voltmind -t http \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Replace `YOUR-DOMAIN` with your ngrok domain and `YOUR_TOKEN` with a token
from `voltmind auth create "claude-code"`.

## Verify

In Claude Code, try:

```
search for [any topic in your brain]
```

You should see results from your VoltMind knowledge base.

## Remove

```bash
claude mcp remove voltmind
```
