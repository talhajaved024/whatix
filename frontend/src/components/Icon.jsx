const icons = {
  hangup: "M2 12.5c4.8-6.1 15.2-6.1 20 0 .5.6.6 1.3.2 2l-1 1.8c-.3.6-1 .8-1.6.6l-3.3-1.2c-.6-.2-.9-.7-.9-1.3v-1.7a12 12 0 0 0-6.8 0v1.7c0 .6-.3 1.1-.9 1.3l-3.3 1.2c-.6.2-1.3 0-1.6-.6l-1-1.8c-.4-.7-.3-1.4.2-2Z",
  mic: "M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z M5 10v1a7 7 0 0 0 14 0v-1 M12 18v4 M9 22h6",
  person: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2",
  document: "M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8",
  chat: "M21 11a9 9 0 0 1-13 8l-5 2 1.5-5A9 9 0 1 1 21 11Z M8 9h8 M8 13h5",
  send: "m3 3 19 9-19 9 3-9-3-9Zm3 9h15",
  clip: "m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2",
  image: "M3 4h18v16H3z M3 17l6-6 4 4 3-3 5 5 M15 8h.01",
  video: "M3 6h12v12H3z M15 10l6-4v12l-6-4",
  link: "m10 13 4-4 M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  close: "m6 6 12 12 M18 6 6 18",
  back: "M15 5l-7 7 7 7",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0",
  users: "M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M17 4a4 4 0 0 1 0 7 M20 20v-2a4 4 0 0 0-3-4",
};
export default function Icon({name}) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={icons[name]} /></svg>;
}
