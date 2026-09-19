import { BookOpen, Scale, ShieldCheck } from "lucide-react";
import styles from "./rules.module.css";

export default function RulesPage() {
  return <div className="page-shell reading-page">
    <header className="page-header"><h1>How Goosey works 🪿</h1></header>
    <section><h2><BookOpen /> Feathers, not dollars</h2><p>Your feathers are just for fun. You can&apos;t buy them, cash them out, or send them to anyone outside Goosey.</p></section>
    <section><h2>Pick a side</h2><p>Think it&apos;ll happen? Bet YES. Think it won&apos;t? Bet NO. Every market has a deadline and rules for deciding who wins.</p></section>
    <section><h2>Watch the odds move</h2><p>Prices change as people trade. They show what everyone thinks might happen, not what will happen.</p></section>
    <section><h2><Scale /> Get your feathers</h2><p>If you&apos;re right, each winning contract pays 100 feathers. If a market is voided, each contract pays 50.</p></section>
    <section id="order-options" className={styles.orderGuide}><h2>Choosing a limit order</h2>
      <p>On an order-book market, your limit is the most you will pay to buy a contract, or the least you will accept to sell one, before fees. A match needs another participant at a compatible price. Placing an order does not guarantee a trade.</p>
      <p><strong>Good until canceled:</strong> trade what is available at your limit or better, then keep the unfilled remainder on the book. You can cancel that remainder without undoing completed fills. You may add an expiration in your local time; pausing or closing the market can also cancel resting orders.</p>
      <p><strong>Immediate or cancel:</strong> fill what is available now at your limit or better and cancel the rest. You may receive a partial fill or no fill, but nothing stays on the book.</p>
      <p><strong>Fill or kill:</strong> fill the whole quantity now at your limit or better, or reject the order with no fills.</p>
      <p><strong>Post-only:</strong> place a good-until-canceled order only if it will rest on the book. If it would trade immediately, the entire order is rejected.</p>
      <p>Open buy orders reserve feathers, including a fee allowance. Open sell orders reserve contracts you already own. Unused backing is released when the order fills, is canceled, or its expiration is processed. Fees apply only to completed fills. The ticket shows the amounts at your limit; execution at a better price can change the final amount.</p>
    </section>
    <section><h2><ShieldCheck /> Don&apos;t be a silly goose</h2><p>No bots, alt accounts, insider info, or being a jerk in the comments. Keep it fun and fair.</p></section>
    <section><h2>How a market is decided</h2><p>Trading stops at the listed close time. One eligible administrator proposes YES, NO, or VOID with evidence from the listed source and rules, and a different eligible administrator approves it. The settlement worker then processes each payout once.</p></section>
  </div>;
}
