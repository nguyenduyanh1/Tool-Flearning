// Bộ vẽ template của Brand Kit — dùng chung cho mọi template.
//
// Template là DỮ LIỆU (templates/<id>/template.json, dựng từ file .ai bằng
// scripts/build-template.mjs rồi soát bằng cách đối chiếu từng pixel với bản gốc).
// Mỗi lớp và mỗi đoạn chữ đã ghi sẵn "on": nằm trên nền hay trên khối nào.
// Bộ vẽ chỉ làm theo luật, không đoán gì lúc chạy:
//   - nền: dải chéo sinh từ màu hãng; "decor" (sóng, vệt sáng của nền gốc) xoay tông
//   - shape "brand": màu hãng, tự đẩy đậm/nhạt tới khi tách khỏi cái nằm dưới (≥ 1,7:1)
//   - shape "ink": giữ màu gốc nếu còn ≥ 3:1 với cái nằm dưới (chuẩn cho hình vẽ), không thì đổi mực
//   - chữ "ink": mực đạt ≥ 4,5:1 với cái nằm dưới (chuẩn WCAG AA cho chữ nhỏ)
//   - "keep": giữ màu gốc (đỏ, lục… mang nghĩa); chữ keep vẫn đổi mực nếu dưới 3:1
//   - card: ảnh gốc kèm chữ bên trong và bóng đổ thật; image: xoay tông nếu tint
// Chữ là khuôn hình chữ gốc (font Rustica của file), tô màu theo luật trên.

(function () {
  var NS = "http://www.w3.org/2000/svg", XL = "http://www.w3.org/1999/xlink";
  var LIGHT = "#FFFFFF", BLACK = "#000000";

  // ---------- màu ----------
  function rgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function toHex(c) { return "#" + c.map(function (v) { return ("0" + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); }).join(""); }
  function hsl(hex) {
    var c = rgb(hex), r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0, s = 0, l = (mx + mn) / 2;
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return [h, s, l];
  }
  function fromHsl(h, s, l) {
    h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
  }
  function lum(hex) {
    return rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
      .reduce(function (a, v, i) { return a + [0.2126, 0.7152, 0.0722][i] * v; }, 0);
  }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

  // Mực đọc được trên một nền: ưu tiên trắng, rồi màu tối cùng tông hãng (đỡ "đen sì"),
  // cuối cùng mới đen tuyệt đối — chỉ đen tuyệt đối mới bảo đảm mọi nền đạt 4,5:1.
  function inkFor(bg, need, brandHue) {
    var dark = fromHsl(brandHue, 0.55, 0.13);
    var list = [LIGHT, dark, BLACK];
    for (var i = 0; i < list.length; i++) if (contrast(list[i], bg) >= need) return list[i];
    return contrast(LIGHT, bg) >= contrast(BLACK, bg) ? LIGHT : BLACK;
  }
  // Giữ sắc độ, đẩy đậm/nhạt tới khi đạt tỉ lệ cần với nền; thử cả hai chiều, lấy chiều đổi ít.
  function separate(h, s, l0, bg, need) {
    var base = fromHsl(h, s, l0);
    if (contrast(base, bg) >= need) return base;
    var best = null;
    [-1, 1].forEach(function (dir) {
      for (var i = 1; i <= 12; i++) {
        var c = fromHsl(h, s, l0 + dir * 0.07 * i);
        if (contrast(c, bg) >= need) { if (!best || i < best.i) best = { i: i, c: c }; return; }
      }
    });
    return best ? best.c : (contrast(LIGHT, bg) >= contrast(BLACK, bg) ? LIGHT : BLACK);
  }

  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function href(n, url) { n.setAttribute("href", url); n.setAttributeNS(XL, "xlink:href", url); }
  var maskSeq = 0;
  // hình tô màu theo khuôn: khuôn là ảnh trắng + độ trong suốt, tô bằng rect cùng khung
  function maskedRect(parent, defs, box, maskUrl, fill) {
    var id = "bk-m" + (++maskSeq);
    var m = el("mask", { id: id, maskUnits: "userSpaceOnUse", x: box.x, y: box.y, width: box.w, height: box.h }, defs);
    href(el("image", { x: box.x, y: box.y, width: box.w, height: box.h, preserveAspectRatio: "none" }, m), maskUrl);
    return el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, mask: "url(#" + id + ")", fill: fill }, parent);
  }

  // ---------- dựng SVG từ template ----------
  function build(container, tpl, base) {
    var svg = el("svg", { viewBox: "0 0 " + tpl.width + " " + tpl.height, xmlns: NS, "xmlns:xlink": XL,
      role: "img", "aria-label": tpl.name });
    var defs = el("defs", {}, svg);
    var grad = el("linearGradient", { id: "bk-bg", x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    var s0 = el("stop", { offset: 0 }, grad), s1 = el("stop", { offset: 1 }, grad);
    var tint = el("filter", { id: "bk-tint", "color-interpolation-filters": "sRGB" }, defs);
    var hue = el("feColorMatrix", { type: "hueRotate", values: 0 }, tint);
    var sil = el("filter", { id: "bk-sil", "color-interpolation-filters": "sRGB" }, defs);
    var silM = el("feColorMatrix", { type: "matrix", values: "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0" }, sil);

    var bgRect = el("rect", { x: 0, y: 0, width: tpl.width, height: tpl.height, fill: "url(#bk-bg)" }, svg);
    var bgOrig = el("image", { x: 0, y: 0, width: tpl.width, height: tpl.height, preserveAspectRatio: "none" }, svg);
    bgOrig.style.display = "none";                   // dải nền gốc — chỉ bật khi đối chiếu

    // vẽ cái nằm dưới trước: lớp trên nền → lớp nằm trên lớp khác → …
    var idx = {}; tpl.layers.forEach(function (L) { idx[L.id] = L; });
    function depth(L) { var d = 0, cur = L; while (cur && cur.on && cur.on !== "bg" && d < 8) { cur = idx[cur.on]; d++; } return d; }
    var order = tpl.layers.map(function (L, i) { return { L: L, i: i, d: L.kind === "decor" ? -1 : depth(L) }; })
      .sort(function (a, b) { return a.d - b.d || a.i - b.i; }).map(function (o) { return o.L; });

    var byId = {}, nodes = [];
    order.forEach(function (L) {
      var n;
      if (L.kind === "shape") n = maskedRect(svg, defs, L, base + L.mask, L.color);
      else {
        n = el("image", { x: L.x, y: L.y, width: L.w, height: L.h, preserveAspectRatio: "none" }, svg);
        href(n, base + L.src);
      }
      var rec = { L: L, n: n, cur: L.color || L.dominant || "#ffffff" };
      byId[L.id] = rec; nodes.push(rec);
    });

    // Chữ: hình chữ vector của font gốc (Rustica trong file .ai), mỗi chữ cái một <use>.
    // Cả đoạn nằm trong một <g fill> → tô màu cả đoạn một lần.
    // mã hình chữ gắn theo trang: bộ slide đánh số hình chữ riêng từng trang, trùng mã
    // giữa hai trang cùng có mặt (vd lúc xuất PDF) sẽ vẽ nhầm chữ của trang kia
    var gp = "bk-" + base.replace(/[^a-z0-9]/gi, "") + "-";
    Object.keys(tpl.glyphs || {}).forEach(function (g) { el("path", { id: gp + g, d: tpl.glyphs[g] }, defs); });
    var lines = tpl.text.map(function (t) {
      return { t: t, spans: t.spans.map(function (s) {
        var g = el("g", { fill: s.color }, svg);
        (s.glyphs || []).forEach(function (q) {
          var u = el("use", { transform: "matrix(" + q.slice(1).join(",") + ")" }, g);
          href(u, "#" + gp + q[0]);
        });
        return { s: s, n: g };
      }) };
    });

    var slots = (tpl.logoSlots || []).map(function (z) {
      var img = el("image", { x: z.x, y: z.y - 2, width: z.w, height: z.h + 4, preserveAspectRatio: "xMidYMid meet" }, svg);
      var txt = el("text", { x: z.x + z.w / 2, y: z.y + z.h * 0.85, "text-anchor": "middle",
        "font-family": "'Figtree', system-ui, sans-serif", "font-weight": 700 }, svg);
      return { z: z, img: img, txt: txt };
    });

    // Logo hình mờ (vd hình sóng chữ "V" của UVsmart ở trang 1): khi có logo của người
    // dùng thì đặt logo vào đúng khung đó, tô đơn sắc tông của hãng như bản gốc.
    var wmF = el("filter", { id: "bk-wm", "color-interpolation-filters": "sRGB" }, defs);
    var wmM = el("feColorMatrix", { type: "matrix", values: "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0" }, wmF);
    var wmLayers = nodes.filter(function (r) { return r.L.watermark; });
    var watermarks = (tpl.watermarks || []).map(function (z) {
      var img = el("image", { x: z.x, y: z.y, width: z.w, height: z.h, preserveAspectRatio: "xMidYMax meet", filter: "url(#bk-wm)" });
      var after = wmLayers.length ? wmLayers[wmLayers.length - 1].n : null;
      if (after) svg.insertBefore(img, after.nextSibling); else svg.insertBefore(img, bgRect.nextSibling);
      img.style.display = "none";
      return { z: z, img: img };
    });

    container.innerHTML = "";
    container.appendChild(svg);
    return { tpl: tpl, base: base, svg: svg, stops: [s0, s1], hue: hue, silM: silM, wmM: wmM, tintF: tint,
      bgRect: bgRect, bgOrig: bgOrig, nodes: nodes, byId: byId, lines: lines, slots: slots,
      watermarks: watermarks, wmLayers: wmLayers };
  }

  // ---------- áp thương hiệu ----------
  // theme = { color, name, logo, logoMono, logoLum } ; theme.original = true → vẽ đúng màu gốc
  // của file (dùng để đối chiếu từng pixel với bản Illustrator)
  function apply(view, theme) {
    var tpl = view.tpl, W = tpl.width, H = tpl.height, orig = !!theme.original;
    var brand = theme.color || tpl.defaultColor || "#12a8c4";
    var bh = hsl(brand), delta = orig ? 0 : bh[0] - (tpl.baseHue || 195);
    var sat = bh[1], lA = Math.min(0.94, bh[2] + 0.10), lB = Math.max(0.10, bh[2] - 0.16), g0, g1;
    function setStops() { g0 = fromHsl(bh[0] - 12, sat, lA); g1 = fromHsl(bh[0] + 16, sat, lB); }
    setStops();
    // Chế độ "keep": giữ nguyên nền gốc (bộ slide Canva nền kem) — màu hãng chỉ đi vào
    // tiêu đề, khối, nhãn. Chế độ "brand" (D60): dải nền sinh từ màu hãng.
    var keepBg = !!(tpl.background && tpl.background.mode === "keep" && tpl.background.color);
    function bgAt(x, y) {
      if (keepBg) return tpl.background.color;
      var t = Math.max(0, Math.min(1, (x / W + y / H) / 2)), a = rgb(g0), b = rgb(g1);
      return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    // chữ lớn (≥ 18pt) chỉ cần 3:1 theo WCAG — giữ được tiêu đề xanh sáng như thiết kế gốc
    function needFor(s) {
      var q = s.glyphs && s.glyphs[0];
      return q && Math.hypot(q[1], q[2]) >= 18 ? 3 : 4.5;
    }
    function onOf(sp, ln) { return sp.s.on || ln.t.on; }
    function spanPt(sp, ln) {
      var s = sp.s, b = ln.t.box;
      var gx = s.glyphs && s.glyphs.length ? (s.glyphs[0][5] + s.glyphs[s.glyphs.length - 1][5]) / 2 : b.x + b.w / 2;
      return [gx, b.y + b.h / 2];
    }

    // 1. MỘT màu mực cho mọi chữ nằm thẳng trên nền — chọn theo từng vị trí thì dải nền
    //    sáng→tối làm dòng này trắng dòng kia đen. Mực không đạt 4,5:1 ở mọi chỗ thì
    //    chỉnh đậm nhạt của dải nền, không đổi màu chữ từng dòng.
    var pts = [];
    view.lines.forEach(function (ln) { ln.spans.forEach(function (sp) {
      if (onOf(sp, ln) === "bg" && sp.s.role !== "keep") pts.push(spanPt(sp, ln));
    }); });
    var darkInk = fromHsl(bh[0], 0.55, 0.13);
    function minC(ink) {
      if (!pts.length) return 99;
      return Math.min.apply(null, pts.map(function (p) { return contrast(ink, bgAt(p[0], p[1])); }));
    }
    var bgInk = LIGHT;
    if (!orig && !keepBg) {
      bgInk = [LIGHT, darkInk, BLACK].map(function (c) { return { c: c, m: minC(c) }; })
        .sort(function (a, b) { return b.m - a.m; })[0].c;
      for (var k = 0; k < 30 && minC(bgInk) < 4.5; k++) {
        if (bgInk === LIGHT) { lA = Math.max(0.05, lA - 0.025); lB = Math.max(0.04, lB - 0.025); }
        else { lA = Math.min(0.97, lA + 0.025); lB = Math.min(0.96, lB + 0.025); }
        setStops();
      }
      if (minC(bgInk) < 4.5 && bgInk === darkInk) bgInk = BLACK;
    }
    view.stops[0].setAttribute("stop-color", g0);
    view.stops[1].setAttribute("stop-color", g1);
    view.bgRect.setAttribute("fill", keepBg ? tpl.background.color : "url(#bk-bg)");
    view.hue.setAttribute("values", Math.round(delta));
    view.bgRect.style.display = orig ? "none" : "";
    view.bgOrig.style.display = orig ? "" : "none";
    if (orig) href(view.bgOrig, view.base + "verify/base.png");

    function behind(on, x, y) {
      if (!on || on === "bg") return bgAt(x, y);
      var r = view.byId[on];
      return r ? r.cur : bgAt(x, y);
    }

    // 2. nhóm đồng bộ: mọi nhãn tiêu đề cùng một màu viên thuốc / ô tròn / chữ / số
    var badges = view.nodes.filter(function (r) { return r.L.group === "badge"; });
    var badgeC = null, dotC = null;
    if (!orig && badges.length) {
      var ls = badges.map(function (r) { return hsl(r.L.color)[2]; });
      var l0 = ls.reduce(function (a, v) { return a + v; }, 0) / ls.length, s0 = Math.max(bh[1], 0.5) * 0.95;
      var ok = function (c) { return badges.every(function (r) { return contrast(c, bgAt(r.L.x + r.L.w / 2, r.L.y + r.L.h / 2)) >= 1.7; }); };
      badgeC = fromHsl(bh[0], s0, l0);
      for (var i = 1; i <= 14 && !ok(badgeC); i++) {
        var up = fromHsl(bh[0], s0, l0 + 0.06 * i), dn = fromHsl(bh[0], s0, l0 - 0.06 * i);
        if (ok(dn)) badgeC = dn; else if (ok(up)) badgeC = up;
      }
      dotC = contrast(LIGHT, badgeC) >= 1.5 ? LIGHT : inkFor(badgeC, 3, bh[0]);
    }

    view.nodes.forEach(function (r) {           // đã xếp "cái dưới trước" lúc dựng
      var L = r.L, under = behind(L.on, L.x + L.w / 2, L.y + L.h / 2);
      if (L.kind === "shape") {
        if (orig || L.role === "keep") r.cur = L.color;
        else if (L.group === "badge") r.cur = badgeC;
        else if (L.group === "badge-dot") r.cur = dotC;
        // màu hãng: dùng thẳng tông của hãng, giữ đậm nhạt gốc
        else if (L.role === "brand") { var o = hsl(L.color); r.cur = separate(bh[0], Math.max(o[1], bh[1]) * 0.95, o[2], under, 1.7); }
        // vụn nhỏ cạnh chữ (dấu, nét rời) → cùng màu chữ trên nền, khỏi lốm đốm
        else if (!keepBg && L.on === "bg" && Math.max(L.w, L.h) < 4) r.cur = bgInk;
        // khối trắng/đen (đĩa tròn, chấm): còn nhìn tách khỏi nền là giữ nguyên
        else r.cur = contrast(L.color, under) >= 1.5 ? L.color : inkFor(under, 3, bh[0]);
        r.n.setAttribute("fill", r.cur);
      } else if (L.kind === "image" || L.kind === "decor") {
        var on = !orig && L.tint;
        if (on) r.n.setAttribute("filter", "url(#bk-tint)"); else r.n.removeAttribute("filter");
        if (L.dominant) { var d = hsl(L.dominant); r.cur = on ? fromHsl(d[0] + delta, d[1], d[2]) : L.dominant; }
      }
    });

    view.lines.forEach(function (ln) {
      ln.spans.forEach(function (sp) {
        var s = sp.s, c, on = onOf(sp, ln), p = spanPt(sp, ln), under = behind(on, p[0], p[1]);
        var grp = view.byId[on] && view.byId[on].L.group;
        if (orig) c = s.color;
        else if (grp === "badge") c = inkFor(badgeC, 4.5, bh[0]);
        else if (grp === "badge-dot") c = contrast(badgeC, dotC) >= 4.5 ? badgeC : inkFor(dotC, 4.5, bh[0]);
        else if (!keepBg && on === "bg" && s.role !== "keep") c = bgInk;
        else if (s.role === "ink") c = contrast(s.color, under) >= needFor(s) ? s.color : inkFor(under, needFor(s), bh[0]);
        else if (s.role === "brand") { var o = hsl(s.color); c = separate(bh[0], Math.max(o[1], bh[1]) * 0.95, o[2], under, needFor(s)); }
        else c = contrast(s.color, under) >= 3 ? s.color : inkFor(under, needFor(s), bh[0]);
        sp.n.setAttribute("fill", c);
      });
    });

    // 3. logo hình mờ: có logo người dùng → ẩn hình gốc, đặt logo đơn sắc tông hãng
    var useWm = !orig && !!theme.logo;
    view.wmLayers.forEach(function (r) { r.n.style.display = useWm ? "none" : ""; });
    if (view.watermarks.length) {
      var wz = view.watermarks[0].z, wu = bgAt(wz.x + wz.w / 2, wz.y + wz.h / 2), wl = hsl(wu)[2];
      var wc = rgb(fromHsl(bh[0], Math.max(bh[1], 0.45) * 0.8, wl > 0.55 ? Math.max(0.15, wl - 0.25) : Math.min(0.88, wl + 0.28)));
      view.wmM.setAttribute("values", "0 0 0 0 " + (wc[0] / 255).toFixed(3) + "  0 0 0 0 " + (wc[1] / 255).toFixed(3) +
        "  0 0 0 0 " + (wc[2] / 255).toFixed(3) + "  0 0 0 0.85 0");
    }
    view.watermarks.forEach(function (w) {
      w.img.style.display = useWm ? "" : "none";
      if (useWm) href(w.img, theme.logoMono
        ? "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(theme.logoMono.replace(/currentColor/gi, "#ffffff"))))
        : theme.logo);
    });

    // Logo luôn trong suốt, không lót khung. Logo không đủ tương phản với nền → đơn sắc.
    var name = theme.name || "Brand";
    view.slots.forEach(function (s) {
      var show = !orig;
      // ô logo có thể nằm trên panel trắng chứ không phải trên dải nền (góc phải trang 2)
      var under = behind(s.z.on, s.z.x + s.z.w / 2, s.z.y + s.z.h / 2);
      var ink = (!keepBg && (!s.z.on || s.z.on === "bg")) ? bgInk : inkFor(under, 4.5, bh[0]), url = theme.logo;
      if (theme.logoMono) url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(theme.logoMono.replace(/currentColor/gi, ink))));
      var lb = lum(under), ll = theme.logoLum;
      var weak = !!theme.logo && !theme.logoMono && ll != null && (Math.max(ll, lb) + 0.05) / (Math.min(ll, lb) + 0.05) < 2.2;
      if (weak) {
        var c = rgb(ink).map(function (v) { return (v / 255).toFixed(3); });
        view.silM.setAttribute("values", "0 0 0 0 " + c[0] + "  0 0 0 0 " + c[1] + "  0 0 0 0 " + c[2] + "  0 0 0 1 0");
        s.img.setAttribute("filter", "url(#bk-sil)");
      } else s.img.removeAttribute("filter");
      s.img.style.display = show && theme.logo ? "" : "none";
      if (theme.logo) href(s.img, url);
      s.txt.style.display = show && !theme.logo ? "" : "none";
      s.txt.setAttribute("fill", ink);
      s.txt.setAttribute("font-size", name.length > 12 ? 8 : name.length > 8 ? 9.5 : 11);
      s.txt.textContent = name;
    });
  }

  // ---------- xuất file ----------
  // SVG xuất ra tự chứa đủ ảnh (data:) và font, vì mở ngoài trình duyệt hay vẽ sang
  // PNG sẽ không tải link ngoài.
  function blobToDataUrl(b) {
    return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.readAsDataURL(b); });
  }
  var cache = {};
  function inline(url) {
    if (/^data:/.test(url)) return Promise.resolve(url);
    if (!cache[url]) cache[url] = fetch(url).then(function (r) { return r.blob(); }).then(blobToDataUrl);
    return cache[url];
  }
  function fontCss() {
    // chữ của template là khuôn hình, chỉ tên hãng dự phòng (khi không có logo) cần font
    return fetch("https://fonts.googleapis.com/css2?family=Figtree:wght@700&display=swap").then(function (r) { return r.text(); })
      .then(function (css) {
        var blocks = css.split("}").filter(function (b) { return /@font-face/.test(b) && /U\+0000-00FF/.test(b); });
        return Promise.all(blocks.map(function (b) {
          var m = b.match(/url\((https:[^)]+)\)/);
          return m ? inline(m[1]).then(function (d) { return b.replace(m[1], d) + "}"; }) : b + "}";
        })).then(function (list) { return list.join("\n"); });
      }).catch(function () { return ""; });
  }
  function exportSvg(view) {
    var copy = view.svg.cloneNode(true);
    [].slice.call(copy.querySelectorAll("[style*='display: none'], [style*='display:none']")).forEach(function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    var imgs = [].slice.call(copy.querySelectorAll("image"));
    return Promise.all(imgs.map(function (im) {
      var u = im.getAttribute("href");
      return u ? inline(u).then(function (d) { href(im, d); }) : null;
    })).then(fontCss).then(function (css) {
      if (css) { var st = document.createElementNS(NS, "style"); st.textContent = css; copy.insertBefore(st, copy.firstChild); }
      copy.setAttribute("width", view.tpl.width); copy.setAttribute("height", view.tpl.height);
      return new XMLSerializer().serializeToString(copy);
    });
  }
  function exportCanvas(view, scale) {
    return exportSvg(view).then(function (xml) {
      return new Promise(function (res, rej) {
        var url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
        var im = new Image();
        im.onload = function () {
          var c = document.createElement("canvas");
          c.width = Math.round(view.tpl.width * scale); c.height = Math.round(view.tpl.height * scale);
          var x = c.getContext("2d");
          x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
          x.drawImage(im, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          res(c);
        };
        im.onerror = function () { URL.revokeObjectURL(url); rej(new Error("Couldn't render the PNG")); };
        im.src = url;
      });
    });
  }
  function exportPng(view, scale) {
    return exportCanvas(view, scale).then(function (c) { return new Promise(function (res) { c.toBlob(res, "image/png"); }); });
  }

  // id = template một trang ("d60-p1") hoặc một trang của bộ slide ("mpc/p07")
  function load(container, id) {
    var base = "templates/" + id + "/";   // tương đối: trang nằm ở /brandkit/
    return fetch(base + "template.json").then(function (r) {
      if (!r.ok) throw new Error("Template not found: " + id);
      return r.json();
    }).then(function (tpl) { return build(container, tpl, base); });
  }

  window.BrandKit = { load: load, apply: apply, exportSvg: exportSvg, exportPng: exportPng, exportCanvas: exportCanvas,
    _util: { contrast: contrast, inkFor: inkFor } };
})();
