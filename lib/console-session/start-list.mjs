// The start list's state (`s` on the dashboard): the agents this host could start, and why it cannot say.
//
// A SEPARATE LIST from the session's processes on purpose: its rows are agents with NO process, so there is nothing
// on the dashboard for them to be an index into. Empty until a caller supplies one -- this object owns no fetch.
// The cursor and the search live in the session's focus, because the router that moves them is pure; this holds
// the rows they index.

import { matchesQuery, startRowTexts } from "../start-list.mjs";

export class StartList {
  /** The agents this host could start, as the last answer named them. */
  rows = [];
  //: Why the list is empty, when it is empty for a reason. "nothing to start" and "aify-comms did not answer" render
  //: identically otherwise, and one of them sends the operator to the wrong place. Empty string means simply empty.
  problem = "";
  //: WHAT THIS HOST REFUSED TO OFFER, grouped by reason. See `notOffered`.
  skipped = [];
  //: WHETHER AN ANSWER HAS ARRIVED AT ALL, which an empty list cannot say on its own. A list that has not been
  //: fetched yet and a host with nothing to start are the same empty array, and reporting the first as the second is
  //: the false green this project keeps finding: the screen would announce "nothing to start" while the request was
  //: still in flight.
  asked = false;
  //: Empty until a caller says who answered.
  service = "";
  //: WHICH OPENING OF THE LIST IS CURRENT (v0.7.1 review, W12). Each opening asks again, and an answer to an earlier
  //: one that lands after a reopen describes the host as it was; the caller compares this before filling the list.
  opening = 0;

  /** The rows under `query`, which is what the cursor and Enter index (v0.7.7). */
  visible(query) {
    return this.rows.filter((agent) => matchesQuery(startRowTexts(agent), query));
  }

  /** Take a fresh answer to "which agents could this host start". */
  note(rows, problem = "", service = "", skipped = []) {
    this.rows = Array.isArray(rows) ? rows.filter((row) => row && row.id) : [];
    this.problem = String(problem || "");
    //: CARRIED, NOT JUDGED. Which groups are worth a row is the renderer's decision and it makes it in one place; a
    //: second filter here would be a second answer to "is this drawable".
    this.skipped = Array.isArray(skipped) ? skipped : [];
    //: WHO WAS ASKED, so the view can say it without knowing it. See the plugin's `service` field.
    this.service = String(service || "");
    this.asked = true;
  }

  /**
   * OPENING THE LIST MARKS IT UNANSWERED AGAIN. The rows from the last time it was open are stale by however long it
   * has been closed, and drawing them as current would let an operator choose an agent that came up ten minutes ago.
   * The caller re-fetches on this action; until it answers, the screen says it is asking rather than saying there is
   * nothing.
   *
   * AND THE OLD ROWS GO WITH IT (v0.7 scan, F8). Resetting only `asked` left them in place, and the renderer asks
   * about `asked` only for an empty list -- so the stale rows were drawn as current and Enter started one of them
   * before the new answer arrived.
   */
  open() {
    this.opening += 1;
    this.asked = false;
    this.rows = [];
    this.problem = "";
    this.skipped = [];
  }

  /** What the renderer draws: the rows under the search, the cursor, and any reason the list is empty. */
  view({ query, at }) {
    return {
      agents: this.visible(query),
      //: How many there are before the search, so the list can say "N of M".
      total: this.rows.length,
      query,
      at,
      problem: this.problem,
      //: So the list can say what it is NOT showing, which is the half that makes a rule visible.
      skipped: this.skipped,
      //: So an unanswered list cannot be drawn as an empty one. See `asked`.
      asked: this.asked,
      service: this.service,
    };
  }
}
