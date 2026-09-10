# Sharing Mandate with testers

Everything here is copy-paste ready. The app is built to explain itself — a first-time visitor
gets a **Start here** checklist that walks them through sign-in, faucet, funding, first trade
and the floor — so you should not have to answer questions one at a time.

---

## The short version (Discord / X / DM)

> I built an onchain prop firm where the rules are a smart contract.
>
> Max drawdown, daily loss, position cap, profit split — all enforced by code, every block. Blow
> the drawdown and the contract closes your position and takes the capital back automatically.
> Hit your target and it pays you out. Nobody can refuse the payout.
>
> The bit I care about: **the consistency rule is a public function.** You can read the exact
> number a prop firm would compute in private and check their maths.
>
> Free, testnet, no signup, no challenge fee. Takes about two minutes.
> Try to break it: <YOUR LINK>

## The longer version (r/propfirms, prop-firm Discords)

> **I blew two funded accounts and got tired of the rules being a PDF.**
>
> The drawdown was never the problem — that number is on your own platform, you can see it. The
> problem is everything you can't see: the risk engine that decides you breached, and the
> consistency rule they compute on their server from their record of your trades.
>
> So I built one where all of it is a smart contract on Monad.
>
> - Your equity is marked **every block** (~0.4s), on chain
> - Breach the drawdown and the contract flattens your position in the same block
> - `consistencyScore(you)` is a public function — read it yourself, re-derive it from events
> - **Anyone** can trigger enforcement. Not just me. That's the point — you don't have to trust
>   that I'll apply the rules fairly, because I can't choose not to
> - No challenge fee. Nobody makes money when you fail
>
> There's also a market where people put up capital against the record you build, and the terms
> get better as your record does — your track record actually travels, instead of being stuck
> inside one firm.
>
> Testnet, free, no signup: <YOUR LINK>
>
> I want it broken. If you find a way to get paid when you shouldn't, or get shut down when you
> shouldn't have been, tell me and I'll fix it.

---

## What to ask testers for

Traction is 20% of the score and it wants **evidence**, not a number you assert. Ask each
tester for:

1. **A screenshot** of their mandate — ideally the moment they breach
2. **One sentence** on what confused them (this is more useful than praise)
3. **The transaction hash** if they got enforced

Keep a running note of: mandates run, breaches correctly enforced, and 3–4 direct quotes.
Screenshot everything as it happens — you will not be able to reconstruct it later.

## Where these people are

- Prop-firm Discords — FundingPips and its competitors
- The funded-trader side of X
- r/Daytrading, r/propfirms, r/Forex
- Monad's own Discord (they will care about the per-block enforcement argument)

## Answering the two questions you will get

**"Is this real money?"**
No. Monad testnet, play money, free from a faucet. Nothing in the app has value.

**"What's the catch / how do you make money?"**
There isn't one and I don't. No challenge fees, no subscription. A prop firm earns when you
fail; here the person who put up the capital simply loses money if you blow up, which is why
they get to set the terms they want and you get to take them or not.
