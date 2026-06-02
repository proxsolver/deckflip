/* =================================================================
   TESLA · Interactive Keynote
   script.js — navigation, scroll-snap sync, entrance motion,
               count-ups, Chart.js, modal sub-pages
   ================================================================= */

(function () {
  "use strict";

  const deck   = document.getElementById("deck");
  const slides = Array.from(document.querySelectorAll(".slide"));
  const root   = document.documentElement;

  const elProgress = document.getElementById("progress");
  const elCurrent  = document.getElementById("counter-current");
  const elTotal    = document.getElementById("counter-total");
  const elSection  = document.getElementById("hud-section");
  const dotsWrap   = document.getElementById("dots");
  const btnPrev    = document.getElementById("prev");
  const btnNext    = document.getElementById("next");
  const scrollHint = document.getElementById("scroll-hint");

  let current = 0;
  const pad = (n) => String(n + 1).padStart(2, "0");

  // Which 3D centrepiece each slide shows. 3D appears only where it is
  // purposeful — the title, section dividers, and the dedicated feature
  // slides. Content / data / grid slides show "none" (ambient only).
  // A slide may override this with a data-model attribute.
  // Three tiers, set via this map + the slide's data-bg preset:
  //   • prominent  (title / dividers / feature slides) — solid, to the side
  //   • ambient    (most content slides) — small, ghostly, rotating in back
  //   • none       (focus slides: agenda, charts, Optimus, closing)
  const MODEL_BY_INDEX = [
    "logo",       // 01 title              · prominent
    "none",       // 02 agenda             · focus
    "logo",       // 03 divider · Company  · prominent
    "logo",       // 04 mission            · ambient
    "logo",       // 05 timeline           · ambient
    "none",       // 06 numbers (chart)    · focus
    "cell",       // 07 divider · Core Tech· prominent
    "cell",       // 08 core tech (feature)· prominent
    "cell",       // 09 battery            · ambient
    "cell",       // 10 manufacturing      · ambient
    "sedan",      // 11 divider · The Fleet· prominent
    "sedan",      // 12 fleet              · ambient
    "sedan",      // 13 Model 3 & Y        · ambient
    "cybertruck", // 14 Cybertruck (feature)· prominent
    "sedan",      // 15 Model S & X        · ambient
    "sedan",      // 16 Semi & Roadster    · ambient
    "sedan",      // 17 divider · Autonomy · prominent
    "sedan",      // 18 Full Self-Driving  · prominent (feature)
    "sedan",      // 19 FSD data           · ambient
    "sedan",      // 20 Cybercab           · ambient
    "none",       // 21 Optimus            · focus (no robot model)
    "powerwall",  // 22 divider · Energy   · prominent
    "powerwall",  // 23 energy ecosystem   · ambient
    "none",       // 24 Powerwall (chart)  · focus
    "powerwall",  // 25 Solar              · ambient
    "powerwall",  // 26 Supercharger       · ambient
    "logo",       // 27 divider · Impact   · prominent
    "logo",       // 28 sustainability     · ambient
    "logo",       // 29 the road ahead     · ambient
    "none",       // 30 closing            · focus (CSS wordmark)
  ];

  /* =================================================================
     BUILD DOT NAVIGATION
     ================================================================= */
  slides.forEach((slide, i) => {
    const b = document.createElement("button");
    b.className = "dot";
    b.setAttribute("aria-label", "Go to slide " + (i + 1));
    const label = document.createElement("span");
    label.className = "dot__label";
    label.textContent = decodeEntities(slide.dataset.section || "Slide " + (i + 1));
    b.appendChild(label);
    b.addEventListener("click", () => goTo(i));
    dotsWrap.appendChild(b);
  });
  const dots = Array.from(dotsWrap.children);
  elTotal.textContent = String(slides.length);

  /* =================================================================
     ACTIVE-SLIDE DETECTION
     Derive the active slide from the scroll position. This is more
     robust than IntersectionObserver across browsers and handles
     wheel, keyboard, touch, and programmatic scrolling identically.
     ================================================================= */
  // While a programmatic jump (dot/keyboard) is animating we ignore the
  // intermediate scroll positions so we don't "scrub" through every slide.
  // Free-scrolling with the wheel/trackpad updates normally.
  let programmatic = false;
  deck.addEventListener(
    "scroll",
    () => {
      if (programmatic) return;
      const idx = Math.max(
        0,
        Math.min(slides.length - 1, Math.round(deck.scrollTop / deck.clientHeight))
      );
      setActive(idx);
    },
    { passive: true }
  );

  function setActive(idx) {
    if (idx === current && slides[idx].classList.contains("active")) return;
    current = idx;
    const slide = slides[idx];

    slides.forEach((s) => s.classList.remove("active"));
    slide.classList.add("active");

    // stagger the entrance animation of this slide's elements
    const items = slide.querySelectorAll("[data-animate]");
    items.forEach((el, i) => el.style.setProperty("--delay", i * 0.08 + "s"));

    // HUD
    elProgress.style.width = ((idx + 1) / slides.length) * 100 + "%";
    elCurrent.textContent = pad(idx);
    elSection.innerHTML = slide.dataset.section || "";

    // theme + 3D focus (placement mood + which centrepiece is shown)
    if (slide.dataset.theme) root.dataset.theme = slide.dataset.theme;
    if (window.TeslaBG) {
      window.TeslaBG.setStage(slide.dataset.bg || "calm");
      window.TeslaBG.showModel(slide.dataset.model || MODEL_BY_INDEX[idx] || "ico");
    }

    // dots
    dots.forEach((d, i) => d.classList.toggle("is-active", i === idx));

    // scroll hint only on first slide
    scrollHint.classList.toggle("is-hidden", idx !== 0);
    btnPrev.classList.toggle("is-hidden", idx === 0);
    btnNext.classList.toggle("is-hidden", idx === slides.length - 1);

    // lazy work: count-ups + charts
    runCountUps(slide);
    maybeBuildChart(slide);
  }

  /* =================================================================
     NAVIGATION
     ================================================================= */
  // Manual eased tween of the scroll position. We briefly disable
  // scroll-snap so `mandatory` snapping doesn't fight the animation
  // (a cross-browser quirk), then restore it on arrival. A timer
  // fallback force-completes the jump if rAF is throttled (e.g. the
  // tab is backgrounded), so navigation never gets stuck.
  let scrollAnim = null;
  let scrollFallback = null;
  function endProgrammatic() {
    programmatic = false;
    deck.style.scrollSnapType = "y mandatory";
  }
  function goTo(i) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    const start = deck.scrollTop;
    const end = i * deck.clientHeight;

    setActive(i); // update HUD / theme / 3D / animations immediately

    if (Math.abs(end - start) < 2) {
      endProgrammatic();
      return;
    }
    if (scrollAnim) cancelAnimationFrame(scrollAnim);
    if (scrollFallback) clearTimeout(scrollFallback);

    programmatic = true;
    deck.style.scrollSnapType = "none";
    const dur = 620;
    const t0 = performance.now();

    function step(now) {
      const p = Math.min((now - t0) / dur, 1);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // easeInOutCubic
      deck.scrollTop = start + (end - start) * e;
      if (p < 1) {
        scrollAnim = requestAnimationFrame(step);
      } else {
        scrollAnim = null;
        endProgrammatic();
      }
    }
    scrollAnim = requestAnimationFrame(step);
    // Safety: force-complete if rAF is throttled (e.g. backgrounded tab)
    scrollFallback = setTimeout(function () {
      if (scrollAnim) { cancelAnimationFrame(scrollAnim); scrollAnim = null; }
      deck.scrollTop = end;
      endProgrammatic();
    }, dur + 280);
  }
  const next = () => goTo(current + 1);
  const prev = () => goTo(current - 1);

  btnNext.addEventListener("click", next);
  btnPrev.addEventListener("click", prev);

  // keyboard — presentation controls
  window.addEventListener("keydown", (e) => {
    if (modalOpen) {
      if (e.key === "Escape") closeModal();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "PageDown":
      case " ":
      case "Spacebar":
        e.preventDefault(); next(); break;
      case "ArrowRight":
        e.preventDefault(); next(); break;
      case "ArrowUp":
      case "PageUp":
      case "ArrowLeft":
        e.preventDefault(); prev(); break;
      case "Home":
        e.preventDefault(); goTo(0); break;
      case "End":
        e.preventDefault(); goTo(slides.length - 1); break;
      case "f":
      case "F":
        toggleFullscreen(); break;
    }
  });

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen || function () {}).call(document.documentElement);
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }

  /* =================================================================
     COUNT-UP NUMBERS  (triggered when a slide becomes active)
     <span data-count="845" data-decimals="0" data-prefix="" data-suffix=""></span>
     ================================================================= */
  function runCountUps(slide) {
    const targets = slide.querySelectorAll("[data-count]");
    targets.forEach((el) => {
      if (el.dataset.done === "1") return;
      el.dataset.done = "1";

      const end = parseFloat(el.dataset.count);
      const decimals = parseInt(el.dataset.decimals || "0", 10);
      const prefix = el.dataset.prefix || "";
      const suffix = el.dataset.suffix || "";
      const dur = 1500;
      const start = performance.now();

      function frame(now) {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
        const val = end * eased;
        el.textContent = prefix + format(val, decimals) + suffix;
        if (p < 1) requestAnimationFrame(frame);
        else el.textContent = prefix + format(end, decimals) + suffix;
      }
      requestAnimationFrame(frame);
    });
  }

  function format(v, decimals) {
    if (decimals > 0) return v.toFixed(decimals);
    // thousands separators for big integers
    return Math.round(v).toLocaleString("en-US");
  }

  /* =================================================================
     CHART.JS  (built lazily, animates on first reveal)
     ================================================================= */
  const charts = {};
  function maybeBuildChart(slide) {
    if (typeof Chart === "undefined") return;
    const dCanvas = slide.querySelector("#chart-deliveries");
    const eCanvas = slide.querySelector("#chart-energy");
    if (dCanvas && !charts.deliveries) charts.deliveries = buildDeliveries(dCanvas);
    if (eCanvas && !charts.energy) charts.energy = buildEnergy(eCanvas);
  }

  function accent() {
    const cs = getComputedStyle(root);
    return {
      a: cs.getPropertyValue("--accent").trim() || "#38bdf8",
      a2: cs.getPropertyValue("--accent-2").trim() || "#8b5cf6",
    };
  }

  function gridDefaults() {
    return {
      grid: { color: "rgba(255,255,255,0.06)", drawBorder: false },
      ticks: { color: "#8a90a0", font: { family: "Pretendard", size: 15 } },
    };
  }

  function buildDeliveries(canvas) {
    const ctx = canvas.getContext("2d");
    const { a, a2 } = accent();
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height || 420);
    grad.addColorStop(0, "rgba(56,189,248,0.45)");
    grad.addColorStop(1, "rgba(56,189,248,0.0)");

    return new Chart(ctx, {
      type: "line",
      data: {
        labels: ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"],
        datasets: [
          {
            label: "Vehicles delivered",
            data: [76, 103, 245, 367, 499, 936, 1314, 1809, 1789, 1700],
            borderColor: a,
            backgroundColor: grad,
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointHoverRadius: 7,
            pointBackgroundColor: "#fff",
            pointBorderColor: a,
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 1800, easing: "easeOutQuart" },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(15,15,22,0.92)",
            borderColor: "rgba(255,255,255,0.12)",
            borderWidth: 1,
            titleColor: "#fff",
            bodyColor: "#cfd4df",
            padding: 12,
            callbacks: { label: (c) => " " + c.parsed.y.toLocaleString() + "K vehicles" },
          },
        },
        scales: {
          x: gridDefaults(),
          y: Object.assign(gridDefaults(), {
            ticks: Object.assign(gridDefaults().ticks, {
              callback: (v) => v / 1000 + "M",
            }),
          }),
        },
      },
    });
  }

  function buildEnergy(canvas) {
    const ctx = canvas.getContext("2d");
    const { a, a2 } = accent();
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height || 420);
    grad.addColorStop(0, a2);
    grad.addColorStop(1, a);

    return new Chart(ctx, {
      type: "bar",
      data: {
        labels: ["2020", "2021", "2022", "2023", "2024", "2025"],
        datasets: [
          {
            label: "Energy storage deployed (GWh)",
            data: [3.0, 4.0, 6.5, 14.7, 31.4, 43.0],
            backgroundColor: grad,
            borderRadius: 10,
            borderSkipped: false,
            maxBarThickness: 64,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 1700, easing: "easeOutQuart", delay: (c) => c.dataIndex * 90 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(15,15,22,0.92)",
            borderColor: "rgba(255,255,255,0.12)",
            borderWidth: 1,
            titleColor: "#fff",
            bodyColor: "#cfd4df",
            padding: 12,
            callbacks: { label: (c) => " " + c.parsed.y + " GWh deployed" },
          },
        },
        scales: {
          x: gridDefaults(),
          y: Object.assign(gridDefaults(), {
            ticks: Object.assign(gridDefaults().ticks, { callback: (v) => v + " GWh" }),
          }),
        },
      },
    });
  }

  /* =================================================================
     MODAL / SUB-PAGES
     ================================================================= */
  const VEHICLES = {
    model3: {
      tag: "Sedan · Volume", name: "Model 3",
      desc: "The refreshed compact sedan that took the mission mainstream — quieter, longer-range, and more efficient than ever.",
      specs: [
        ["EPA range", "up to ~363 mi"], ["0–60 mph", "2.9 s (Performance)"],
        ["Top speed", "up to 163 mph"], ["Drag coefficient", "0.219 Cd"],
        ["Drivetrain", "RWD / Dual-motor AWD"], ["Seating", "5 adults"],
      ],
      note: "Figures vary by trim and model year.",
    },
    modely: {
      tag: "SUV · Best-seller", name: "Model Y",
      desc: "The best-selling vehicle in the world, refreshed for 2025. A versatile crossover on the Model 3 platform.",
      specs: [
        ["EPA range", "up to ~330 mi"], ["0–60 mph", "3.5 s (Performance)"],
        ["Seating", "5 (opt. 7)"], ["Cargo", "~76 cu ft"],
        ["Drivetrain", "RWD / Dual-motor AWD"], ["Tow rating", "up to 3,500 lb"],
      ],
      note: "Figures vary by trim and model year.",
    },
    models: {
      tag: "Flagship · Sedan", name: "Model S Plaid",
      desc: "A full-size luxury sedan with tri-motor performance that embarrasses purpose-built supercars.",
      specs: [
        ["0–60 mph", "1.99 s"], ["Top speed", "200 mph"],
        ["Power", "1,020 hp"], ["EPA range", "up to ~402 mi"],
        ["Quarter mile", "9.23 s"], ["Drivetrain", "Tri-motor AWD"],
      ],
      note: "1.99 s with rollout subtracted, on prepared surface.",
    },
    modelx: {
      tag: "Flagship · SUV", name: "Model X Plaid",
      desc: "Falcon-wing doors, seating for seven, and supercar acceleration in a full-size SUV body.",
      specs: [
        ["0–60 mph", "2.5 s"], ["Top speed", "163 mph"],
        ["Power", "1,020 hp"], ["EPA range", "up to ~335 mi"],
        ["Seating", "up to 7"], ["Drivetrain", "Tri-motor AWD"],
      ],
      note: "Figures vary by trim and model year.",
    },
    cybertruck: {
      tag: "Truck · Exoskeleton", name: "Cybertruck",
      desc: "An ultra-hard 30X cold-rolled stainless-steel exoskeleton on an 800-volt architecture. Built to be nearly indestructible.",
      specs: [
        ["0–60 mph", "2.6 s (Cyberbeast)"], ["Power", "845 hp (Cyberbeast)"],
        ["Range", "up to ~325 mi"], ["Battery", "123 kWh · 800 V"],
        ["Max towing", "11,000 lb"], ["Starting price", "$69,990"],
      ],
      note: "Cyberbeast from $99,990. Range varies with wheels and load.",
    },
    roadster: {
      tag: "Supercar · Halo", name: "Roadster",
      desc: "The next-generation halo car — designed to reset every benchmark for what a production car can do.",
      specs: [
        ["0–60 mph", "< 2.0 s (target)"], ["Range", "~620 mi (target)"],
        ["Top speed", "250+ mph (target)"], ["Seating", "2+2"],
        ["Drivetrain", "Tri-motor AWD"], ["Torque", "10,000 N·m (claimed)"],
      ],
      note: "Manufacturer targets for an upcoming model; subject to change.",
    },
  };

  const modal = document.getElementById("modal");
  const modalBody = document.getElementById("modal-body");
  let modalOpen = false;
  let lastFocus = null;

  document.querySelectorAll("[data-modal]").forEach((btn) => {
    btn.addEventListener("click", () => openModal(btn.dataset.modal));
  });
  modal.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeModal)
  );

  function openModal(key) {
    const v = VEHICLES[key];
    if (!v) return;
    modalBody.innerHTML =
      '<span class="modal__tag">' + v.tag + "</span>" +
      '<h2 class="modal__title" id="modal-title">' + v.name + "</h2>" +
      '<p class="modal__desc">' + v.desc + "</p>" +
      '<dl class="modal__specs">' +
      v.specs
        .map(
          (s) =>
            '<div class="modal__spec"><dt>' + s[0] + "</dt><dd>" + s[1] + "</dd></div>"
        )
        .join("") +
      "</dl>" +
      '<p class="modal__note">' + (v.note || "") + "</p>";

    lastFocus = document.activeElement;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    modalOpen = true;
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    modalOpen = false;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* =================================================================
     INIT
     ================================================================= */
  function decodeEntities(str) {
    const t = document.createElement("textarea");
    t.innerHTML = str;
    return t.value;
  }

  // activate first slide on load
  setActive(0);
  // ensure progress/counter correct even before first IO callback
  elProgress.style.width = (1 / slides.length) * 100 + "%";

  // hide the scroll hint after a short while
  setTimeout(() => scrollHint.classList.add("is-hidden"), 6000);
})();
