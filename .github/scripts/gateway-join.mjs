// Joins rooms through a running gateway as the dev stack's people and checks
// each answer, so the scope file, the seed's roles and the pinned gateway are
// tested together. Needs `dev/up.sh` and a gateway on 127.0.0.1:8787.

const cases = [
  { sub: "ana", room: "lobby", want: "hello" },
  { sub: "ana", room: "studio", want: "hello" },
  { sub: "ben", room: "studio", want: "forbidden" },
];

async function answer(sub, room) {
  const minted = await fetch(`http://127.0.0.1:9400/token?sub=${sub}&aud=felix-canvas`);
  const { id_token: token } = await minted.json();
  const socket = new WebSocket("ws://127.0.0.1:8787/ws");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no answer in 15 s")), 15_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "join", protocol: 1, room, token }));
    socket.onerror = () => reject(new Error("socket error"));
    socket.onmessage = (event) => {
      clearTimeout(timer);
      const message = JSON.parse(event.data);
      socket.close();
      resolve(message.type === "error" ? message.code : message.type);
    };
  });
}

let failed = 0;
for (const { sub, room, want } of cases) {
  const got = await answer(sub, room);
  console.log(`${got === want ? "ok  " : "FAIL"} ${sub} joins ${room}: ${got}, want ${want}`);
  if (got !== want) failed += 1;
}
process.exit(failed ? 1 : 0);
