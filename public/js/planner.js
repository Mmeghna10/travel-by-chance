// "Plan my arrival day" page: saves the arrival details, then fetches the
// plan (polling while nearby places are fetched for the first time) and
// renders it. Place names come from OpenStreetMap, i.e. untrusted text, so
// everything is built with textContent, never innerHTML.
(function () {
  const form = document.getElementById("arrival-form");
  if (!form) return;
  const bookingId = form.dataset.booking;
  const statusEl = document.getElementById("planner-status");
  const result = document.getElementById("plan-result");
  const rentalField = document.getElementById("rental-field");

  form.mode.addEventListener("change", () => {
    rentalField.hidden = form.mode.value !== "rental";
  });

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function link(href, text) {
    const a = el("a", "planner-link", text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  function stopCard(stop, index) {
    const card = el("li", "planner-stop");
    const head = el("div", "planner-stop-head");
    head.append(el("span", "planner-stop-num", String(index + 1)), el("span", "planner-stop-name", stop.name));
    card.append(head);
    if (stop.localName) card.append(el("div", "planner-muted", stop.localName));
    const travel = `${stop.travelMinutes} min travel${typeof stop.km === "number" ? ` · ${stop.km} km` : ""}`;
    card.append(el("div", "planner-line", `${travel} → arrive ${stop.arriveAt}`));
    if (stop.waitMinutes > 0) card.append(el("div", "planner-line planner-wait", `Opens at ${stop.startAt}: ${stop.waitMinutes} min to spare`));
    card.append(el("div", "planner-line", `See it ${stop.startAt} – ${stop.leaveAt} (${stop.visitMinutes} min, ${stop.kind})`));
    const hours = el("div", "planner-line " + (stop.hoursConfirmed ? "planner-ok" : "planner-warn"));
    hours.textContent = stop.hoursConfirmed
      ? (stop.closesAt === "midnight" ? "Open until midnight" : `Closes ${stop.closesAt}`) + (stop.hoursSource === "curated" ? " (official timings)" : " (OpenStreetMap)")
      : `Hours not published: planned within typical hours (closes ~${stop.closesAt}). Check before going.`;
    if (stop.hoursNote) hours.title = stop.hoursNote;
    card.append(hours);
    card.append(link(stop.directionsUrl, "Directions"));
    return card;
  }

  function windowSection(title, win, endLabel) {
    const section = el("section", "planner-card");
    section.append(el("h2", "planner-h2", title));
    section.append(el("p", "planner-muted", `${win.startAt} – ${win.endAt} · ${win.modeLabel}${win.modeNote ? ` (${win.modeNote})` : ""}`));
    if (win.rentalMinutes) section.append(el("p", "planner-line", `Pick up your rented vehicle first (${win.rentalMinutes} min).`));
    if (win.leaveHotelAt) section.append(el("p", "planner-line", `Rest at the hotel; leave at ${win.leaveHotelAt} to arrive as the first place opens.`));
    if (!win.stops.length) {
      section.append(el("p", "planner-muted", "Nothing fits in this time (closing times and travel). Relax at the hotel."));
      return section;
    }
    const list = el("ol", "planner-stops");
    win.stops.forEach((s, i) => list.append(stopCard(s, i)));
    section.append(list);
    const back = el("p", "planner-line planner-back-line", `${win.returnTravelMinutes} min back to the hotel → ${endLabel} ${win.returnAt}`);
    if (win.returnDirectionsUrl) back.append(" ", link(win.returnDirectionsUrl, "Directions"));
    section.append(back);
    return section;
  }

  function render(plan) {
    result.replaceChildren();
    const summary = el("div", "planner-card planner-summary");
    summary.append(
      el("div", "planner-line", `Arrive ${plan.arrivalAt} · check in ${plan.checkInAt} · ${plan.modeLabel}`),
      el("div", "planner-muted", `${plan.placesNearby} places found nearby on OpenStreetMap; the best ${plan.placesConsidered} were considered. Travel times: ${plan.travelSource === "mapbox" ? "live road data (Mapbox)" : "estimated from distance"}.`),
    );
    result.append(summary);
    if (plan.before) result.append(windowSection("Before check-in", plan.before, "back for check-in at"));
    const checkIn = el("div", "planner-card planner-checkin", `Check in at ${plan.checkInAt}`);
    result.append(checkIn);
    if (plan.after) result.append(windowSection("After check-in", plan.after, "back at the hotel at"));
    else result.append(el("p", "planner-muted", "You arrive too late for sightseeing today. Rest up!"));
    const notes = el("ul", "planner-notes");
    plan.notes.forEach((n) => notes.append(el("li", null, n)));
    result.append(notes);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadPlan() {
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = await fetch(`/api/v1/bookings/${bookingId}/arrival-plan`, { headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        statusEl.textContent = body.message || "Finding places near your stay…";
        await sleep(5000);
        continue;
      }
      if (!res.ok) throw new Error(body.message || "Couldn't build a plan right now.");
      return body.plan;
    }
    throw new Error("Finding nearby places is taking unusually long. Please try again in a few minutes.");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    statusEl.textContent = "Saving your arrival details…";
    try {
      const prefs = {
        arrivalTime: form.arrivalTime.value,
        mode: form.mode.value,
        rentalMinutes: Number(form.rentalMinutes.value || 0),
        dayEndsAt: form.dayEndsAt.value,
      };
      const saved = await fetch(`/api/v1/bookings/${bookingId}/arrival`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(prefs),
      });
      const savedBody = await saved.json().catch(() => ({}));
      if (!saved.ok) throw new Error(savedBody.message || "Couldn't save your arrival details.");
      statusEl.textContent = "Planning your day…";
      render(await loadPlan());
      statusEl.textContent = "";
      result.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
})();
