import { useEffect, useRef } from "react";

export default function SessionPill({name,number}) {
  const tag = useRef(null);
  const motion = useRef(null);

  useEffect(() => () => motion.current?.cancel(), []);

  function reveal(open) {
    const el = tag.current;
    el.parentElement.style.pointerEvents = open ? "auto" : "none";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!motion.current) {
      motion.current = el.animate([
        {opacity:0,transform:"translateY(-9px) scale(.36,.2)",offset:0},
        {opacity:1,transform:"translateY(3px) scale(.95,1.1)",offset:.58},
        {opacity:1,transform:"translateY(-1px) scale(1.025,.97)",offset:.82},
        {opacity:1,transform:"none",offset:1}
      ],{duration:340,easing:"ease-in-out",fill:"both"});
      motion.current.pause();
      motion.current.currentTime = 0;
    }
    const animation = motion.current;
    if (reduced) {
      animation.pause();
      animation.currentTime = open ? 340 : 0;
      return;
    }
    if (open && animation.currentTime >= 340 || !open && animation.currentTime <= 0) {
      animation.pause();
      return;
    }
    animation.playbackRate = open ? 1 : -1;
    animation.play();
  }

  return <code className="session-pill" tabIndex={0} aria-describedby="session-number"
    onPointerEnter={()=>reveal(true)}
    onPointerLeave={event=>reveal(event.currentTarget.matches(":focus-visible"))}
    onFocus={()=>reveal(true)}
    onBlur={event=>reveal(event.currentTarget.matches(":hover"))}
    onKeyDown={event=>{if(event.key==="Escape") reveal(false);}}>
    <span>{name}</span>
    <span className="session-drop-zone">
      <span className="session-number" id="session-number" role="tooltip" ref={tag}>{number}</span>
    </span>
  </code>;
}
