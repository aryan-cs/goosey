# Hack the North 2026 market lineup

Schedule verified September 19, 2026 against https://my.hackthenorth.com/schedule and https://hackthenorth.com/. All displayed times below are EDT (America/Toronto). Hacking ends Sunday September 20 at 8 a.m.; closing ceremonies run 2:30–4:30 p.m. The goose-report deadline uses the end of closing ceremonies, not the submission deadline.

Opening probabilities are editorial judgments, with a rationale in each market's rules and catalog entry. They are not measured event frequencies. YES contracts pay 100 feathers, so a 35% opening probability corresponds to an approximately 35-feather marginal YES price (NO approximately 65); an actual trade moves the LMSR curve. Integer house inventory means the opening price can differ slightly from the target. House positions are funded from treasury collateral and do not create trades, volume, or participant counts.

## Lineup

| Market | Opening YES | Trading closes (EDT) | Expected result (EDT) |
|---|---:|---|---|
| Will the geese choose violence at HTN? | 60% | Sep 20, 4:30 p.m. | Sep 20, 4:30 p.m. |
| Three goose attacks. Are we cooked? | 35% | Sep 20, 4:30 p.m. | Sep 20, 4:30 p.m. |
| Six goose attacks: has campus been claimed? | 15% | Sep 20, 4:30 p.m. | Sep 20, 4:30 p.m. |
| Will Waterloo defend home turf? | 60% | Sep 20, 2:30 p.m. | Sep 20, 4:30 p.m. |
| Will Goosey actually win something? | 25% | Sep 20, 2:30 p.m. | Sep 20, 4:30 p.m. |
| Will a first-year take everyone's chips? | 35% | Sep 19, 8:30 p.m. | Sep 19, 10:00 p.m. |
| Will someone ask for a job on the closing mic? | 30% | Sep 20, 2:30 p.m. | Sep 20, 4:30 p.m. |
| Will actual hardware beat the wrappers? | 60% | Sep 20, 2:30 p.m. | Sep 20, 4:30 p.m. |
| Will someone say 'honk' on the closing mic? | 40% | Sep 20, 2:30 p.m. | Sep 20, 4:30 p.m. |
| Will we boil noodles before we ship code? | 65% | Sep 20, 3:00 a.m. | Sep 20, 3:15 a.m. |
| Will karaoke get Rickrolled? | 55% | Sep 19, 9:00 p.m. | Sep 19, 11:00 p.m. |
| Will the boba arrive before we lose it? | 65% | Sep 19, 3:30 p.m. | Sep 19, 3:45 p.m. |
| Will a goose make the final demo? | 45% | Sep 20, 2:30 p.m. | Sep 20, 4:30 p.m. |
| Will a finalist get hit by the demo gods? | 60% | Sep 20, 2:30 p.m. | Sep 20, 4:30 p.m. |

Expected result times are evidence-review targets. Cancellation or unavailable evidence after 48 hours produces VOID; absence of proof does not automatically mean NO. Resolution still uses the existing proposal/approval process. Moderators must obtain the records specified in each market before deciding it. The goose thresholds overlap: one shared verified count determines all three outcomes. Incidents can predate market publication within the defined event window, but reports must arrive between publication and Sunday 4:30 p.m.

Pull-ups are intentionally omitted pending the user's event details. The official schedule does not list a pull-up competition. HTN markets use overall winning projects rather than inventing a ranked first/second/third-place podium.

## Reference adaptations

All nine supplied public Timbermarket pages were read on September 19:

- [Stanford wins](https://www.timbermarket.lol/markets/27f64914-7b3b-4332-abed-7413d09f78e0): Waterloo-majority overall winning team.
- [Timbermarket wins a prize](https://www.timbermarket.lol/markets/ccf6f272-cfb9-4945-bdef-b56c57878255): Goosey wins an official project prize.
- [Poker-night prize](https://www.timbermarket.lol/markets/95cadcd8-7c76-476c-acff-2cfe94c3c834) and [first-year lightsaber champion](https://www.timbermarket.lol/markets/df853bab-63d1-4c6e-aa29-28e1510ea61f): first-year poker champion at HTN's scheduled tournament.
- [Push-up record](https://www.timbermarket.lol/markets/4a4efe75-df79-4dac-b956-85cc561fd59f): held for verified fitness-event details.
- [Public job request](https://www.timbermarket.lol/markets/b4bcfd86-60e1-41bf-8ca2-410e42b9577c): direct job request on the closing microphone.
- [Hardware winner](https://www.timbermarket.lol/markets/132ab241-93cb-4d11-837e-2d8fed7412c3): essential custom hardware in an overall winning project.
- [Closing speaker says potato](https://www.timbermarket.lol/markets/8aa054ba-bacd-4339-8a64-47b1dd3de709): closing microphone says “honk.”
- [Boil the ocean](https://www.timbermarket.lol/markets/5fbc80ba-4d50-4038-9bcf-c17e2bbc707f): hot ramen served before 3:15 a.m., based on the scheduled overnight service.

## Local replacement

Preview with `DATABASE_URL=file:./dev.db node --import tsx scripts/replace-markets.ts`. Apply with the same command plus `--apply`.

The command backs up SQLite under ignored `output/database-backups`, refuses legacy markets with participant or settlement activity, refunds untouched seed funding through balanced journal entries, removes the old lineup, and runs the catalog seed. Users and historical journal entries remain. Cleanup is transactional; catalog seeding follows separately and can be safely retried if it fails. The seed does not overwrite existing markets' prices or rules on rerun. This local SQLite command does not publish a deployment or modify PostgreSQL.
