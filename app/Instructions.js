"use client";

// Expandable help panel. Kept as its own component so page.js stays about
// behaviour rather than copy.
export default function Instructions() {
  return (
    <div className="instructions">
      <p className="instructions-lead">
        Paste the whole load block into the <b>PASTE HERE 🔽</b> column — one
        paste can fill several rows at once, and it fills the stop type, date and
        time, facility name and address together. Then add the truck # or Samsara
        Live Share link and press <b>Save &amp; Check</b>. Everything after that
        is automatic.
      </p>

      <div className="instructions-grid">
        <pre>{`Pickup: 05/11/26 04:00 AM
USPS
80 COUNTY RD
Jersey City, NJ 07097

Delivery: 05-12-2026 10:00 AM
USPS
4931 CONFLANS RD
Irving, TX 75059`}</pre>

        <pre>{`Pickup: 07/28/26 22:00 PM
ST. LOUIS
3951 NEW TOWN BLVD
SAINT CHARLES, MO 63301
————————
Delivery: 07/29/26 23:59 PM
N SALT LAKE CTY
750 NORTH 5600 WEST
SALT LAKE CITY, UT 84116`}</pre>

        <pre>{`✅PU: 07/27/26 2200 - Appt set
HOME DEPOT (LUCKEY,OH)
22671 Pemberville Rd
Luckey, OH 43443

🛑DEL: 07/29/26 0800 - Appt set
TEMCO LOGISTICS (LAKE ELMO, MN)
11190 Hudson Blvd N
Lake Elmo, MN 55042`}</pre>
      </div>

      <ul className="instructions-notes">
        <li>
          <b>DATE &amp; TIME</b> is the appointment. <b>ALERT IF LATE THAN…</b> is
          what actually triggers the email. They stay in step until you edit the
          alert time yourself — after that it stays put, and a 🔗 appears if you
          want to re-link it.
        </li>
        <li>
          A <b>Samsara Live Share link</b> works even without a destination set in
          Samsara — we use the delivery address from your paste.
        </li>
        <li>
          Tick the <b>⏰</b> box in Notes to be reminded 5 minutes before the
          appointment to confirm the driver actually walked in and checked in.
        </li>
        <li>
          A stop is marked <b>Arrived</b> automatically once the truck is within a
          mile, and stops being checked after that.
        </li>
        <li>
          You can track up to <b>100 loads</b>. The table opens with 10 rows and
          adds more as you go — there are always 5 blank rows below the last one
          you filled in, so you never have to ask for another.
        </li>
      </ul>
    </div>
  );
}
