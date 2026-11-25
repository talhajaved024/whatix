// Split-flap ("airport board") word for the sign-in brand.
// visible=true: tiles shuffle through a few characters and settle on the word,
// left to right, once the sign-in card has grown to make room. visible=false:
// tiles flip back to blank, right to left, and the word fades out before the
// card shrinks (timing in styles.css). The tiles animate transforms and opacity only.
import {useEffect,useRef,useState} from "react";

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789!?";
const FLIP_MS = 130;     // one flip: top half falls, bottom half lands
const STAGGER_MS = 45;   // delay between neighbouring tiles
const HIDE_STAGGER_MS = 30;
const REVEAL_DELAY_MS = 170; // wait for the card to open space (--reveal-delay in styles.css)
const calm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function Tile({flip}) {
  const {from, to, id} = flip;
  return <span className="flap">
    {/* Static halves: the new top is revealed as the old top falls away; the
        old bottom stays until the new bottom lands over it. */}
    <span className="flap-half flap-top"><span>{to}</span></span>
    <span className="flap-half flap-bottom"><span>{id ? from : to}</span></span>
    {id > 0 && <>
      <span key={"f" + id} className="flap-half flap-top flap-fall"><span>{from}</span></span>
      <span key={"l" + id} className="flap-half flap-bottom flap-land"><span>{to}</span></span>
    </>}
  </span>;
}

export default function SplitFlap({text, visible}) {
  const letters = Array.from(text);
  const [flips, setFlips] = useState(() => letters.map(() => ({from:"", to:"", id:0})));
  const timers = useRef([]);
  const counter = useRef(0);

  useEffect(() => {
    const later = (ms, fn) => timers.current.push(setTimeout(fn, ms));
    const flipTo = (index, next) => setFlips(previous => previous.map((flip, i) =>
      i !== index || flip.to === next ? flip : {from:flip.to, to:next, id:++counter.current}));
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (calm()) { setFlips(letters.map(letter => ({from:"", to:visible ? letter : "", id:0}))); return; }
    if (visible) {
      letters.forEach((letter, index) => {
        // Later tiles shuffle a little longer, so the word settles left to right.
        const steps = 2 + Math.ceil(index / 2);
        for (let step = 0; step < steps; step++) {
          const next = step === steps - 1 ? letter : CHARSET[Math.floor(Math.random() * CHARSET.length)];
          later(REVEAL_DELAY_MS + index * STAGGER_MS + step * FLIP_MS, () => flipTo(index, next));
        }
      });
    } else {
      letters.forEach((_, index) => later((letters.length - 1 - index) * HIDE_STAGGER_MS, () => flipTo(index, "")));
    }
    return () => { timers.current.forEach(clearTimeout); timers.current = []; };
  // letters is derived from text
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, text]);

  // The fade-out waits until the tiles have flipped back to blank.
  const hideDelay = (letters.length - 1) * HIDE_STAGGER_MS + FLIP_MS / 2;
  return <span className={"split-flap" + (visible ? " is-shown" : "")} aria-hidden="true"
    style={{"--flip-ms":FLIP_MS + "ms", "--hide-delay":hideDelay + "ms"}}>
    {flips.map((flip, index) => <Tile key={index} flip={flip}/>)}
  </span>;
}
