import { BookOpen, Scale, ShieldCheck } from "lucide-react";
import styles from "./rules.module.css";

export default function RulesPage() {
  return <div className="page-shell reading-page">
    <header className="page-header"><h1>How Goosey works</h1><p>Feathers are play money. You cannot buy them, cash them out, or send them outside Goosey.</p></header>
    <section><h2><BookOpen /> Every market needs a clear answer</h2><p>Each question has a deadline, a trusted source, and one exact way to settle YES or NO. We do not allow harmful, private, or easy-to-rig questions.</p></section>
    <section><h2><Scale /> Prices and payouts</h2><p>Prices move as people trade. A winning contract pays 100 feathers. If a market is voided, each contract pays 50 feathers. Prices show what the crowd thinks, not what is guaranteed to happen.</p></section>
    <section id="order-options" className={styles.orderGuide}><h2>Choosing a limit order</h2>
      <p>On an order-book market, your limit is the most you will pay to buy a contract, or the least you will accept to sell one, before fees. A match needs another participant at a compatible price. Placing an order does not guarantee a trade.</p>
      <p><strong>Good until canceled:</strong> trade what is available at your limit or better, then keep the unfilled remainder on the book. You can cancel that remainder without undoing completed fills. You may add an expiration in your local time; pausing or closing the market can also cancel resting orders.</p>
      <p><strong>Immediate or cancel:</strong> fill what is available now at your limit or better and cancel the rest. You may receive a partial fill or no fill, but nothing stays on the book.</p>
      <p><strong>Fill or kill:</strong> fill the whole quantity now at your limit or better, or reject the order with no fills.</p>
      <p><strong>Post-only:</strong> place a good-until-canceled order only if it will rest on the book. If it would trade immediately, the entire order is rejected.</p>
      <p>Open buy orders reserve feathers, including a fee allowance. Open sell orders reserve contracts you already own. Unused backing is released when the order fills, is canceled, or its expiration is processed. Fees apply only to completed fills. The ticket shows the amounts at your limit; execution at a better price can change the final amount.</p>
    </section>
    <section><h2><ShieldCheck /> Play fair</h2><p>Do not use multiple accounts, private organizer info, bots, or abusive comments. We may pause a market if something looks unfair.</p></section>
    <section><h2>How a market is decided</h2><p>Trading stops at the listed close time. One eligible administrator proposes YES, NO, or VOID with evidence from the listed source and rules, and a different eligible administrator approves it. The settlement worker then processes each payout once.</p></section>
  </div>;
}
