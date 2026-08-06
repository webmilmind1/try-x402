#!/usr/bin/env node
/**
 * try-x402: pay a real x402 endpoint from your terminal.
 *
 * x402 is an open standard where a server answers HTTP 402 with payment terms, the
 * client pays in stablecoin, and the request succeeds. No account, no API key, no
 * subscription. This tool exists because trying that normally means writing a client
 * first, and most people never get past that.
 *
 * It works against ANY x402 server. It defaults to a DeskCrew endpoint because we
 * maintain it and it costs two cents, but --url points it anywhere.
 *
 * Deliberately dependency-light: viem only, with the EIP-3009 authorization signed
 * inline rather than pulled from an SDK. A tool that asks for a private key should be
 * short enough to read in full before you run it.
 *
 * SAFETY
 *  - Use a THROWAWAY wallet. This prints one for you if you have no key.
 *  - The key is read from X402_KEY, or generated in memory. It is never written to
 *    disk and never sent anywhere except as a signature.
 *  - --dry-run shows the payment terms and pays nothing.
 */
import {
  createPublicClient, createWalletClient, http, formatUnits, parseAbi,
  toHex, hexToBigInt,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import * as chains from 'viem/chains'

// `--flag value` and `--flag=value` are both normalised to the separated form.
// This is money-moving code and the parser used to match `--dry-run` EXACTLY, so
// `--dry-run=true` (an ordinary way to write it) left DRY false and made a REAL
// payment. An unrecognised flag is now fatal rather than ignored, for the same
// reason: silently discarding an instruction the user typed is how you spend money
// they did not agree to spend.
const ARGV = process.argv.slice(2).flatMap((a) =>
  a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a],
)
const has = (f) => ARGV.includes(f)
const val = (f, d) => { const i = ARGV.indexOf(f); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d }

const KNOWN_FLAGS = new Set(['--json', '--dry-run', '--url', '--chain', '--body', '--max-price', '--help'])
for (const a of ARGV) {
  if (a.startsWith('--') && !KNOWN_FLAGS.has(a)) {
    console.error(`unknown option ${a}. Known: ${[...KNOWN_FLAGS].join(', ')}`)
    process.exit(2)
  }
}

const JSON_OUT = has('--json')
const DRY = has('--dry-run')
const URL_ = val('--url', null) || ARGV.find((a) => a.startsWith('http')) || 'https://deskcrew.io/api/x402/paid/ping'
const BODY = val('--body', null) || ARGV.find((a) => a.trim().startsWith('{')) || '{}'

// The ceiling the SERVER CANNOT INFLUENCE. Without it the only check before signing
// was "can you afford this", which a hostile endpoint satisfies by quoting exactly
// your balance. Deliberately small: this tool exists to try a few-cent payment, so
// anything larger should be a conscious act.
const MAX_PRICE_USDC = Number(val('--max-price', '1'))
if (!Number.isFinite(MAX_PRICE_USDC) || MAX_PRICE_USDC <= 0) {
  console.error('--max-price must be a positive number of USDC')
  process.exit(2)
}

const out = { steps: [] }
const say = (human, data) => {
  if (JSON_OUT) { if (data) Object.assign(out, data); out.steps.push(human) }
  else console.log(human)
}
const finish = (ok, extra = {}) => {
  Object.assign(out, extra, { ok })
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
  process.exit(ok ? 0 : 1)
}
const die = (msg, extra) => { if (!JSON_OUT) console.error(`\n${msg}`); finish(false, { error: msg, ...extra }) }

// Chain registry: friendly x402 network name to viem chain plus its USDC contract and
// the EIP-712 domain name that contract actually reports. The domain name is NOT
// uniform across chains, and getting it wrong produces a signature that recovers to the
// wrong address, which servers reject with no useful explanation.
const NETWORKS = {
  base:      { chain: chains.base,      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', domain: 'USD Coin' },
  polygon:   { chain: chains.polygon,   usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', domain: 'USD Coin' },
  avalanche: { chain: chains.avalanche, usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', domain: 'USD Coin' },
  sei:       { chain: chains.sei,       usdc: '0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392', domain: 'USDC' },
  'base-sepolia': { chain: chains.baseSepolia, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', domain: 'USDC' },
}

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function name() view returns (string)',
  'function version() view returns (string)',
])

// ---- 1. wallet -------------------------------------------------------------------
let key = process.env.X402_KEY
let generated = false
if (!key) {
  key = generatePrivateKey()
  generated = true
}
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('X402_KEY must be 0x followed by 64 hex characters.')
const account = privateKeyToAccount(key)

if (!JSON_OUT) {
  console.log('\n  try-x402: pay a real HTTP 402 endpoint\n')
}
say(`wallet: ${account.address}`, { wallet: account.address })
if (generated && !JSON_OUT) {
  console.log('\n  A throwaway wallet was generated for this run.')
  console.log('  To reuse it, save this key somewhere safe and export it next time:')
  console.log(`\n    export X402_KEY=${key}\n`)
  console.log('  Never put a real wallet key here. This one holds only what you send it.')
}

// ---- 2. ask the server what it wants ---------------------------------------------
say(`\ncalling ${URL_} with no payment, to read its terms...`, { url: URL_ })
let res
try {
  res = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: BODY })
} catch (e) { die(`could not reach ${URL_}: ${e?.message ?? e}`) }

if (res.status !== 402) {
  const text = await res.text()
  if (res.ok) {
    say(`\nThat endpoint answered ${res.status} without asking for payment. Nothing to pay for.`)
    finish(true, { status: res.status, paid: false, body: text.slice(0, 400) })
  }
  // An MCP endpoint answers 400 to anything that is not a JSON-RPC call, so it never
  // reaches its own 402. Without this hint the first thing a curious dev sees when
  // they point this at an MCP server is a validation error about a field they were
  // never told to send, which reads like the payment rail is broken when it is not.
  const looksMcp = /\/mcp\b/.test(URL_) || /jsonrpc|tools\/call|params\.name/i.test(text)
  if (res.status === 400 && looksMcp) {
    die(
      `${URL_} is an MCP endpoint: it wants a JSON-RPC call, so it never got as far as asking for payment.\n` +
        `  Retry with a tool call, for example:\n\n` +
        `    npx try-x402 --url ${URL_} \\\n` +
        `      --body '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{}}}'\n\n` +
        `  server said: ${text.slice(0, 160)}`,
    )
  }
  die(`expected HTTP 402, got ${res.status}: ${text.slice(0, 200)}`)
}

// v1 puts the challenge in the body; v2 puts it on the PAYMENT-REQUIRED header.
let challenge, dialect
const v2header = res.headers.get('payment-required')
const bodyText = await res.text()
try { challenge = JSON.parse(bodyText); dialect = 'v1' } catch { /* not v1 */ }
if (!challenge && v2header) {
  try { challenge = JSON.parse(Buffer.from(v2header, 'base64').toString('utf8')); dialect = 'v2' } catch { /* no */ }
}
if (!challenge) die('the 402 carried no payment terms we could read (neither a v1 body nor a v2 PAYMENT-REQUIRED header).')

const accepts = challenge.accepts || []
if (!accepts.length) die('the 402 listed no acceptable payment methods.')

const wanted = val('--chain', null)
const pick = wanted
  ? accepts.find((a) => (a.network || '').includes(wanted))
  : accepts.find((a) => NETWORKS[a.network]) || accepts[0]
if (!pick) die(`the server does not accept ${wanted}. It accepts: ${accepts.map((a) => a.network).join(', ')}`)

const netName = pick.network
const net = NETWORKS[netName] || Object.values(NETWORKS).find((n) => `eip155:${n.chain.id}` === netName)
if (!net) die(`this tool does not yet know how to pay on "${netName}". Known: ${Object.keys(NETWORKS).join(', ')}`)

// ⚠️ THE SERVER DOES NOT GET TO CHOOSE THE TOKEN.
// `pick.asset` used to flow straight into the EIP-712 `verifyingContract`, while the
// balance check below read the canonical USDC for the chain. A hostile endpoint could
// therefore quote a DIFFERENT EIP-3009 token (EURC on Base, say), have us sign an
// authorization against that contract, and pass a USDC balance check that had nothing
// to do with what was being spent. The theft would then be reported as
// "spent: 0.000000 USDC" because the summary re-reads USDC too.
//
// We already know the right contract and its EIP-712 domain name for every chain we
// support, verified on-chain, so there is no reason to take the server's word.
// This tool pays USDC. If a server wants something else, it can say so and we refuse.
if (pick.asset && pick.asset.toLowerCase() !== net.usdc.toLowerCase()) {
  die(
    `this server wants to be paid in a token that is not the canonical USDC on ${netName}.\n` +
      `  it asked for: ${pick.asset}\n` +
      `  USDC on ${netName} is: ${net.usdc}\n` +
      `  Refusing: try-x402 only pays USDC, and signing against an unknown contract is how funds get taken.`,
    { refused: 'non-usdc-asset', requestedAsset: pick.asset },
  )
}

const atomic = BigInt(pick.maxAmountRequired ?? pick.amount ?? 0)
const price = formatUnits(atomic, 6)

// ⚠️ A CEILING THE SERVER CANNOT MOVE.
// The only gate before signing used to be "is your balance >= this", which asks
// whether you CAN pay, never whether you AGREED to. A hostile endpoint satisfies it
// by quoting exactly your balance, and drains the wallet in one signature. Balances
// are public, so it does not even need to ask.
if (atomic > BigInt(Math.round(MAX_PRICE_USDC * 1e6))) {
  die(
    `this server asked for ${price} USDC, above the ${MAX_PRICE_USDC} USDC limit.\n` +
      `  Nothing was signed. If you genuinely mean to pay that much:\n\n` +
      `      npx try-x402 --url ${URL_} --max-price ${price}`,
    { refused: 'over-max-price', priceUsdc: price, maxPriceUsdc: String(MAX_PRICE_USDC) },
  )
}
say(`\nserver wants ${price} USDC on ${netName} (${dialect} dialect)`, {
  dialect, network: netName, priceUsdc: price, payTo: pick.payTo,
})
say(`  pay to: ${pick.payTo}`)
if (pick.description) say(`  for:    ${pick.description}`)

if (DRY) {
  say('\nDRY RUN. Nothing was paid.')
  finish(true, { paid: false, dryRun: true })
}

// ---- 3. funding ------------------------------------------------------------------
const pub = createPublicClient({ chain: net.chain, transport: http(process.env.X402_RPC_URL || undefined) })
let bal = await pub.readContract({ address: net.usdc, abi: ERC20, functionName: 'balanceOf', args: [account.address] })
say(`\nyour balance: ${formatUnits(bal, 6)} USDC on ${netName}`, { balanceUsdc: formatUnits(bal, 6) })

if (bal < atomic) {
  if (JSON_OUT) die(`insufficient USDC: need ${price}, have ${formatUnits(bal, 6)}`, { needUsdc: price })

  // A GENERATED wallet with no money is the default first run: someone typed
  // `npx try-x402` to see what happens. Waiting for them to fund an address they
  // met two seconds ago is not a real workflow, and silently polling for it looks
  // exactly like the program has hung. So say what happened and stop.
  if (generated) {
    console.log(`\n  This run made a brand new wallet, so it holds no USDC and cannot pay.\n`)
    console.log(`  To watch the whole flow without spending anything:\n`)
    console.log(`      npx try-x402 --dry-run\n`)
    console.log(`  To actually pay, use a wallet that already holds USDC:\n`)
    console.log(`      export X402_KEY=0xyour_private_key`)
    console.log(`      npx try-x402\n`)
    console.log(`  Or fund this address with at least ${price} USDC on ${netName} and re-run`)
    console.log(`  with the key printed above:\n`)
    console.log(`      ${account.address}\n`)
    console.log(`  You never need ETH for gas. The server pays it.`)
    die('no funds in a freshly generated wallet')
  }

  // A wallet the caller SUPPLIED is a different situation: they meant to pay and may
  // be topping it up right now, so waiting is genuinely useful. Bounded, with the
  // time shown, and with the way out stated before the wait starts rather than after.
  const WAIT_MS = 3 * 60 * 1000
  console.log(`\n  Not enough USDC. Send at least ${price} USDC (on ${netName}) to:\n`)
  console.log(`    ${account.address}\n`)
  console.log('  You do NOT need any ETH: the server pays the gas.')
  console.log(`  Waiting up to 3 minutes. Press Ctrl+C to stop, nothing has been spent.\n`)
  const started = Date.now()
  const deadline = started + WAIT_MS
  while (bal < atomic && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    bal = await pub.readContract({ address: net.usdc, abi: ERC20, functionName: 'balanceOf', args: [account.address] })
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    const line = `  balance: ${formatUnits(bal, 6)} USDC, ${left}s left`
    // \r only redraws on a terminal. Piped or redirected it just concatenates into
    // one unreadable line, which is how this looked when it was first reported.
    if (process.stdout.isTTY) process.stdout.write(`\r${line}   `)
    else console.log(line)
  }
  if (process.stdout.isTTY) console.log('')
  if (bal < atomic) die('timed out waiting for funds. Re-run once the USDC has landed.')
}

// ---- 4. sign the payment ---------------------------------------------------------
// EIP-3009 transferWithAuthorization: an off-chain signature the server broadcasts and
// pays gas for. This is why the buyer needs no native token.
const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
const now = Math.floor(Date.now() / 1000)
const authorization = {
  from: account.address,
  to: pick.payTo,
  value: atomic.toString(),
  validAfter: '0',
  // Clamped. An unclamped server value lets a hostile endpoint hold a valid
  // authorization over your wallet for years and settle it whenever it suits them.
  validBefore: String(now + Math.min(Number(pick.maxTimeoutSeconds) || 300, 600)),
  nonce,
}
// The EIP-712 domain name must match what the USDC contract reports, which differs by
// chain. Read it rather than assume, then fall back to the server's own hint.
let domainName = net.domain
try {
  domainName = await pub.readContract({ address: net.usdc, abi: ERC20, functionName: 'name' })
} catch { /* keep the table value */ }
// EIP-3009 USDC deployments are all version "2". Taking this from the challenge let a
// server complete the shaping of a domain it should have no say in at all.
const domainVersion = '2'

const signature = await account.signTypedData({
  domain: {
    // All four fields from OUR pinned table, never from the challenge. The asset was
    // already checked to equal net.usdc above, so there is nothing the server can
    // shift here: not the token, not the chain, not the domain the signature binds to.
    name: domainName,
    version: domainVersion,
    chainId: net.chain.id,
    verifyingContract: net.usdc,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: authorization.from,
    to: authorization.to,
    value: atomic,
    validAfter: 0n,
    validBefore: BigInt(authorization.validBefore),
    nonce,
  },
})

const payload = { signature, authorization }
const envelope = dialect === 'v2'
  ? { x402Version: 2, accepted: { scheme: pick.scheme ?? 'exact', network: netName }, payload }
  : { x402Version: 1, scheme: pick.scheme ?? 'exact', network: netName, payload }
const header = Buffer.from(JSON.stringify(envelope)).toString('base64')

say('\npaying...')
const paidRes = await fetch(URL_, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    [dialect === 'v2' ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT']: header,
  },
  body: BODY,
})
const paidBody = await paidRes.text()
const receipt = paidRes.headers.get('payment-response') || paidRes.headers.get('x-payment-response')

say(`status: ${paidRes.status}`, { status: paidRes.status, response: paidBody.slice(0, 600) })

if (receipt) {
  try {
    const r = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8'))
    say(`\nSETTLED. tx ${r.transaction} on ${r.network}`, { settled: true, tx: r.transaction, txNetwork: r.network })
    if (!JSON_OUT && r.network === 'base') console.log(`  https://basescan.org/tx/${r.transaction}`)
  } catch { say(`settled (raw receipt: ${receipt.slice(0, 60)})`, { settled: true }) }
} else {
  say('\nNo settlement receipt came back, so nothing was charged.', { settled: false })
}

const after = await pub.readContract({ address: net.usdc, abi: ERC20, functionName: 'balanceOf', args: [account.address] })
const spent = formatUnits(bal - after, 6)
say(`spent: ${spent} USDC`, { spentUsdc: spent })

if (!JSON_OUT) {
  console.log('\n  That was a real payment over an open standard. No account, no card, no signup.')
  console.log('  Point this at any x402 server with --url, or read the terms first with --dry-run.')
  // The other direction: this tool demonstrates SPENDING; the bounty board pays agents
  // for approved support answers. One line, after success only, because a person who
  // just watched a payment settle is the person who asks "can it earn, too?".
  console.log('\n  Your agent can also EARN: real tickets carry USDC bounties, a human approves,')
  console.log('  the wallet gets 85%. Try it free:  npx x402-bounty-hunter --dry-run\n')
}
finish(true, { paid: true })
