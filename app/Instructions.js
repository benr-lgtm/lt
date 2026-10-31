"use client";

// Expandable help panel. Kept as its own component so page.js stays about
// behaviour rather than copy.
//
// Every example below was run through lib/parseLoads.js and produces the result
// described. If the parser changes, re-check them — a help panel that promises
// a format the parser rejects is worse than no help panel.
export default function Instructions() {
  return (
    <div className="instructions">
      <p className="instructions-lead">
        Enter the stop type and appointment in the board. Open <b>Stop info</b>{" "}
        for the facility and address, or paste dispatch notes there to fill
        <b> several rows at once</b>. Add a truck # or Samsara/Motive share link.
        Changes save automatically; turn on <b>Track</b> for scheduled checks
        and late email alerts, or choose <b>Update all now</b> for a one-time check.
      </p>

      <p className="instructions-lead">
        Paste a <b>delivery on its own</b>, a <b>pickup on its own</b>, or{" "}
        <b>both together in any order</b> — mixed styles in one paste are fine.
        All it needs on the first line is <b>DEL</b>, <b>PU</b>,{" "}
        <b>Delivery</b> or <b>Pickup</b> <i>and</i> a date.
      </p>

      <div className="instructions-grid">
        <pre>{`🛑DEL: 07/31/26 0800 - Appt set
HOME DEPOT
22671 Pemberville Rd
Luckey, OH 43443`}</pre>

        <pre>{`Pickup: 05/11/26 04:00 AM
USPS
80 COUNTY RD
Jersey City, NJ 07097`}</pre>

        <pre>{`✅PU: 07/27/26 2200 - Appt set
SHAMROCK FDS
2926 W ENCANTO BLVD
PHOENIX, AZ 85009
————————
🛑DEL: 07/29/26 0800
TEMCO LOGISTICS
11190 Hudson Blvd N
Lake Elmo, MN 55042`}</pre>
      </div>

      <p className="instructions-note-lead">All of these are understood:</p>
      <ul className="instructions-notes">
        <li>
          <b>Labels</b> — <code>DEL</code>, <code>PU</code>,{" "}
          <code>Delivery</code>, <code>Pickup</code>, upper or lower case, with
          or without a colon. Emoji and bullets in front (🛑 ✅ •) are ignored.
        </li>
        <li>
          <b>Dates</b> — <code>07/31/26</code>, <code>07/31/2026</code>,{" "}
          <code>05-12-2026</code>.
        </li>
        <li>
          <b>Times</b> — <code>0800</code>, <code>2200</code>,{" "}
          <code>04:00 AM</code>, <code>23:59</code>. No time on the line? It's
          set to <b>23:59</b> and the row says so — adjust it if the appointment
          is earlier.
        </li>
        <li>
          <b>Extra words</b> like &ldquo;Appt set&rdquo;, &ldquo;straight&rdquo;
          or &ldquo;Ready now&rdquo; are kept as notes, not mistaken for a time.
        </li>
        <li>
          <b>Suite and dock numbers</b> — <code>STE 200</code>,{" "}
          <code>DOCK 5</code>, <code>APT 4B</code> are dropped before the address
          is looked up, because they confuse geocoders.
        </li>
      </ul>

      <p className="instructions-note-lead">Once the row is filled in:</p>
      <ul className="instructions-notes">
        <li>
          <b>DATE &amp; TIME</b> is the appointment. <b>ALERT IF LATER THAN…</b>{" "}
          is what actually triggers the email. They stay in step until you edit
          the alert time yourself — after that it stays put, and a 🔗 appears if
          you want to re-link it.
        </li>
        <li>
          Appointment times are the <b>delivery&rsquo;s local time</b>. The small
          tag beside each date (<b>CDT</b>, <b>PDT</b>…) shows which zone that
          is, so type the time exactly as it appears on the load.{" "}
          <b>Last updated</b> and <b>Next check</b> are the only columns on{" "}
          <i>your</i> clock.
        </li>
        <li>
          <b>Next check</b> shows when the row is looked at again, and how often.
          Loads with hours of slack are checked every few hours; a load running
          tight is checked every few minutes. A slightly stale ETA on a load with
          plenty of room is the system saving your quota, not a fault.
        </li>
        <li>
          A stop is marked <b>Arrived</b> automatically — either within 0.1 mi of
          the address, or parked within half a mile of it for 15+ minutes, which
          catches trucks sitting in a big yard.
        </li>
        <li>
          Tick <b>Remind</b> to be prompted 5 minutes before the appointment to
          confirm the driver actually walked in and checked in.
        </li>
        <li>
          A <b>Samsara or Motive vehicle share link</b> works without a
          destination set in the provider — we use the delivery address from
          your paste.
        </li>
        <li>
          <b>Motion</b> shows Rolling or Stopped from the latest available
          provider reading. Old readings are labelled stale.
        </li>
        <li>
          You can track up to <b>100 loads</b>. The table opens with 10 rows and
          adds more as you go — there are always 5 blank rows below the last one
          you filled in, so you never have to ask for another.
        </li>
        <li>
          <b>$2 per stop</b>, charged only once the truck <b>arrives</b> or you
          mark it <b>checked in</b>. A load that never completes is never
          charged.
        </li>
      </ul>

      <div className="instructions-video">
        <p className="instructions-note-lead">Watch it done</p>
        {/*
          preload="none" is deliberate: this panel is collapsed by default and
          most sessions never open it, so the video must not cost every visitor
          a download. The poster is a still frame, so there is something to look
          at before anything is fetched.
        */}
        <video
          controls
          preload="none"
          poster="/instructions-poster.png"
          className="instructions-player"
        >
          <source src="/instructions.mp4" type="video/mp4" />
          Your browser can&rsquo;t play this video.{" "}
          <a href="/instructions.mp4">Download it instead</a>.
        </video>
        <p className="instructions-video-note">
          Three minutes, no sound needed — pasting a load block, adding the truck
          #, and running Update all now.
        </p>
      </div>
    </div>
  );
}
