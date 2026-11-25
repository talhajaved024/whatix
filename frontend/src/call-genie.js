const duration = 620;
const smooth = value => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

export function dismissCallBanner(banner, finish) {
  if (document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finish();
    return;
  }
  const rect = banner.getBoundingClientRect();
  const targetY = window.innerHeight - 10 - rect.top;
  const layer = document.createElement("div");
  layer.className = "call-genie";
  layer.inert = true;
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, {left:rect.left+"px", top:rect.top+"px", width:rect.width+"px"});

  // Bend the actual banner, including the caller and handset, in horizontal bands.
  const bands = [];
  const count = 16;
  const height = rect.height / count;
  for (let i = 0; i < count; i++) {
    const band = document.createElement("div");
    band.className = "call-genie-band";
    band.style.height = height + 0.25 + "px";
    const copy = banner.cloneNode(true);
    copy.classList.remove("call-leaving");
    Object.assign(copy.style, {height:rect.height+"px", top:-i*height+"px"});
    band.append(copy);
    layer.append(band);
    bands.push(band);
  }
  document.body.append(layer);
  const start = performance.now();
  let frame;
  function edge(row, time) {
    const depth = row / count;
    const delay = (1 - depth) * 0.36;
    const pinch = smooth((time - delay) / 0.53);
    const travel = smooth((time - delay - 0.08) / (0.92 - delay));
    const y = row * height;
    return {width:1 - 0.986 * pinch, y:y + (targetY - y) * travel};
  }
  function draw(now) {
    const time = Math.min(1, (now - start) / duration);
    let top = edge(0, time);
    for (let i = 0; i < count; i++) {
      const bottom = edge(i + 1, time);
      // Map the rectangle to a trapezoid whose edges join its neighbors exactly.
      const ratio = top.width / bottom.width;
      const scaleY = (bottom.y - top.y) / height * ratio;
      bands[i].style.transform = `translateY(${top.y}px) matrix3d(${top.width},0,0,0, 0,${scaleY},0,${(ratio-1)/height}, 0,0,1,0, 0,0,0,1)`;
      top = bottom;
    }
    layer.style.opacity = 1 - smooth((time - 0.88) / 0.12);
    if (time < 1) frame = requestAnimationFrame(draw);
  }
  draw(start);
  // A background tab can suspend animation frames mid-dismissal.
  const timer = setTimeout(finish, duration);
  return () => { clearTimeout(timer); cancelAnimationFrame(frame); layer.remove(); };
}
