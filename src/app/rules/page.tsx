import Link from "next/link";
import { BookOpen, Mail, Scale, ShieldCheck, Trophy } from "lucide-react";
import styles from "./rules.module.css";

export default function RulesPage() {
  return <div className="page-shell reading-page">
    <header className="page-header"><span className="eyebrow">Rules and disclosures</span><h1>How Goosey works 🪿</h1><p>These rules explain account responsibilities, play-money markets, and the terms that apply when you use Goosey.</p></header>
    <section><h2><BookOpen /> Feathers, not dollars</h2><p>Your feathers are just for fun. You can&apos;t buy them, cash them out, or send them to anyone outside Goosey.</p></section>
    <section><h2>Pick a side</h2><p>Think it&apos;ll happen? Bet YES. Think it won&apos;t? Bet NO. Every market has a deadline and rules for deciding who wins.</p></section>
    <section><h2>Watch the odds move</h2><p>Prices change as people trade. They show what everyone thinks might happen, not what will happen.</p></section>
    <section><h2><Scale /> Market settlement</h2><p>If you&apos;re right, each winning contract credits 100 play-money feathers. If a market is voided, each contract credits 50 play-money feathers.</p></section>
    <section id="order-options" className={styles.orderGuide}><h2>Choosing a limit order</h2>
      <p>On an order-book market, your limit is the most you will pay to buy a contract, or the least you will accept to sell one, before fees. A match needs another participant at a compatible price. Placing an order does not guarantee a trade.</p>
      <p><strong>Good until canceled:</strong> trade what is available at your limit or better, then keep the unfilled remainder on the book. You can cancel that remainder without undoing completed fills. You may add an expiration in your local time; pausing or closing the market can also cancel resting orders.</p>
      <p><strong>Immediate or cancel:</strong> fill what is available now at your limit or better and cancel the rest. You may receive a partial fill or no fill, but nothing stays on the book.</p>
      <p><strong>Fill or kill:</strong> fill the whole quantity now at your limit or better, or reject the order with no fills.</p>
      <p><strong>Post-only:</strong> place a good-until-canceled order only if it will rest on the book. If it would trade immediately, the entire order is rejected.</p>
      <p>Open buy orders reserve feathers, including a fee allowance. Open sell orders reserve contracts you already own. Unused backing is released when the order fills, is canceled, or its expiration is processed. Fees apply only to completed fills. The ticket shows the amounts at your limit; execution at a better price can change the final amount.</p>
    </section>
    <section><h2><Mail /> Use a real account email</h2><p>You must register with a valid, current email address that you own or lawfully control and monitor regularly. You are responsible for maintaining access to that address and keeping it current. Goosey may require verification or re-verification before you can access certain features, establish eligibility, or receive an award or payment. Subject to applicable law, the verified email associated with your account is Goosey&apos;s authoritative address for account, security, and legal notices. See the <Link href="/terms">Terms of Use</Link> and <Link href="/privacy">Privacy Notice</Link>.</p></section>
    <section id="prizes"><h2><Trophy /> Prizes and separate payments</h2><p>Feathers do not create a right to money or prizes. If Goosey separately determines that you qualify for a cash prize, award, reimbursement, or distribution under written program terms, Goosey will use your verified registered email to identify and contact the intended account holder. Additional identity, age, residency, tax, fraud-prevention, and payment-method checks may be required. Registering or verifying an email does not itself create or guarantee eligibility.</p></section>
    <section><h2><ShieldCheck /> Don&apos;t be a silly goose</h2><p>No bots, alt accounts, insider info, or being a jerk in the comments. Keep it fun and fair.</p></section>
    <section><h2>How a market is decided</h2><p>Trading stops at the listed close time. One eligible administrator proposes YES, NO, or VOID with evidence from the listed source and rules, and a different eligible administrator approves it. The settlement worker then processes each payout once.</p></section>
  </div>;
}
