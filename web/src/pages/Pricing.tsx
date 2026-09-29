import { Link } from 'react-router-dom';
import { CREDITS_PER_USD_PURCHASED, PLANS, PRICE_IN_PER_M_USD, PRICE_OUT_PER_M_USD } from '@tide/shared';
import { useAuth } from '../lib/auth';
import { Footer } from '../components/Nav';
import { fmtInt } from '../lib/format';
import type { PlanInfo } from '../lib/types';

const PERKS: Record<string, string[]> = {
  free: ['5 free prompts to start', 'Daily credit grant for chat', 'All models the network serves', 'Pay-as-you-go credits any time'],
  pro: ['Grant covers chat and API calls', 'Not affected when free lanes pause', 'All models, thinking mode included', 'Bought credits never expire'],
  max: ['2.5× the Pro daily grant', 'Built for heavy API and agent use', 'Everything in Pro'],
};

const FAQ = [
  ['What is a credit?', 'One credit is $0.001 of inference. A typical chat message costs about one credit; long answers and long conversations cost more because you pay per token: $0.15 per million input tokens and $0.90 per million output tokens.'],
  ['What happens when my daily grant runs out?', 'Chats and API calls draw from your purchased credit balance. If you have none, you will be asked to top up or wait for the grant to reset at 00:00 UTC.'],
  ['Do unused grant credits roll over?', 'No — the daily grant resets every day at 00:00 UTC. Credits you buy never expire.'],
  ['Why is pay-as-you-go more expensive than plans?', '$1 buys 500 credits pay-as-you-go ($0.002 each), while plans work out much cheaper per credit if you use them. Plans are the cheap path; pay-as-you-go is the flexible one.'],
  ['How am I charged if I stop an answer early?', 'Credits are held up front for the worst case, then settled to the exact tokens delivered. If nothing was generated, you are refunded in full.'],
  ['Where does my money go?', 'Node operators receive 70% of what you pay for the tokens their GPUs generate. If someone referred you, they get 5%. The rest keeps Tide running: the orchestrator, free daily credits and development.'],
  ['Are my prompts stored?', 'No. Prompts and outputs are streamed through the orchestrator to a node and back, and never written to our database. Chat history lives only in your browser.'],
  ['How do I pay?', 'Payments are in USDC on Solana. Checkout is rolling out now; until then local/dev builds can activate plans and add test credits from Settings.'],
];

export default function Pricing() {
  const { pricing, me } = useAuth();
  const plans: PlanInfo[] = pricing?.plans ?? (Object.values(PLANS) as PlanInfo[]);
  const currentPlan = me && me.user.kind !== 'anon' ? me.plan.id : null;
  const rate = pricing?.textRate ?? { usdPerMInput: PRICE_IN_PER_M_USD, usdPerMOutput: PRICE_OUT_PER_M_USD };
  const perUsd = pricing?.creditsPerUsdPurchased ?? CREDITS_PER_USD_PURCHASED;

  return (
    <>
      <div className="page wrap">
        <div className="page-head center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="eyebrow">pricing</div>
          <h1>Pay for tokens, <em>not</em> data centers.</h1>
          <p>Every plan includes a daily credit grant. Need more? Buy credits that never expire.</p>
        </div>

        <div className="plans">
          {plans.map((p) => {
            const featured = p.id === 'pro';
            return (
              <div key={p.id} className={`card plan${featured ? ' glow' : ''}`}>
                <div className="row-between">
                  <span className="eyebrow">{p.name}</span>
                  {featured && <span className="badge foam">popular</span>}
                  {currentPlan === p.id && <span className="badge sky">current</span>}
                </div>
                <div className="price">${p.priceUsd}<small> / month</small></div>
                <div className="mono small"><span className="foam">{fmtInt(p.dailyCredits)}</span> <span className="muted">credits every day</span></div>
                <div className="tiny dim">≈ {fmtInt(p.dailyCredits * 30)} credits / month · resets 00:00 UTC</div>
                <ul>{(PERKS[p.id] ?? []).map((x) => <li key={x}>{x}</li>)}</ul>
                <Link to={p.id === 'free' ? '/chat' : '/settings#plans'} className={`btn ${featured ? 'btn-foam' : 'btn-ghost'} btn-block`}>
                  {p.id === 'free' ? 'Start chatting' : currentPlan === p.id ? 'Manage plan' : `Get ${p.name}`}
                </Link>
              </div>
            );
          })}
        </div>

        <h2 className="section-title" style={{ marginTop: 72 }}>How credits work</h2>
        <div className="grid grid-4">
          <div className="tile"><div className="v">$0.001</div><div className="l">1 credit</div><div className="s">of inference</div></div>
          <div className="tile"><div className="v">~1</div><div className="l">credit / message</div><div className="s">for a typical chat reply</div></div>
          <div className="tile"><div className="v">{fmtInt(perUsd)}</div><div className="l">credits per $1</div><div className="s">pay-as-you-go, never expire</div></div>
          <div className="tile"><div className="v">00:00</div><div className="l">UTC grant reset</div><div className="s">daily grant refills</div></div>
        </div>
        <div className="card" style={{ marginTop: 18 }}>
          <div className="row-between">
            <div>
              <h3>Per-token rates</h3>
              <p className="small muted">Same price on every model. Credits are held up front and settled to the exact tokens delivered.</p>
            </div>
            <div className="row mono" style={{ gap: 24 }}>
              <div><div className="foam" style={{ fontSize: 22, fontWeight: 600 }}>${rate.usdPerMInput.toFixed(2)}</div><div className="tiny muted">per 1M input tokens</div></div>
              <div><div className="foam" style={{ fontSize: 22, fontWeight: 600 }}>${rate.usdPerMOutput.toFixed(2)}</div><div className="tiny muted">per 1M output tokens</div></div>
            </div>
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>
            Order of spending: free prompts → today's grant → purchased credits. The Free plan's grant works in chat; Pro and Max grants also cover API calls.
          </p>
        </div>

        <div className="row" style={{ marginTop: 18, gap: 12 }}>
          <Link to="/settings#credits" className="btn btn-foam">Buy credits</Link>
          <Link to="/settings#plans" className="btn btn-ghost">Compare my plan</Link>
        </div>

        <h2 className="section-title" id="faq" style={{ marginTop: 72 }}>FAQ</h2>
        <div className="faq">
          {FAQ.map(([q, a]) => (
            <details key={q}><summary>{q}</summary><p>{a}</p></details>
          ))}
        </div>
      </div>
      <Footer />
    </>
  );
}
