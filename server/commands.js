// Typed commands: a message that starts with "/" is parsed here (server-side, so every client gets them).
// They are the user's hard controls over the story; the reply route turns them into directions,
// cast changes, or verbatim lines that never go through the model.
const ALIASES = {
  help: "help", "?": "help", commands: "help",
  force: "force", f: "force", must: "force", do: "force",
  narrate: "narrate", n: "narrate", narrator: "narrate",
  say: "say", as: "say", puppet: "say",
  steer: "steer", s: "steer",
  time: "time", skip: "time",
  scene: "scene", cut: "scene",
  twist: "twist", event: "twist",
  enter: "enter", add: "enter", arrive: "enter",
  leave: "leave", exit: "leave",
  note: "note", director: "note",
  ooc: "ooc",
};

export const COMMANDS = [
  { usage: "/force <what happens>", help: "Hard direction. The next reply makes this happen, whoever speaks, and characters may only react to it." },
  { usage: "/narrate <what happens>", help: "The Narrator makes it happen this beat." },
  { usage: "/say <Name>: <their line>", help: "Write a character's (or the Narrator's) line yourself. No AI involved, always exact." },
  { usage: "/steer <instruction>", help: "One-off instruction for the next reply. Not shown in the story." },
  { usage: "/time <how much>", help: "Skip time, e.g. /time the next morning." },
  { usage: "/scene <where, when>", help: "Cut to a new scene." },
  { usage: "/twist [what kind]", help: "Throw in a complication." },
  { usage: "/enter <Name>: <who they are>", help: "A new person walks in right now and joins the cast." },
  { usage: "/leave <Name>", help: "That character leaves and is gone from the story." },
  { usage: "/note <standing direction>", help: "Set the director's note the AI always follows here. /note off clears it." },
  { usage: "/ooc <text>", help: "Out-of-character note; the AI answers briefly and continues." },
];

/** "/cmd rest of line" -> { cmd, arg } ; unknown "/foo" -> { cmd: "unknown", name: "foo" } ; plain text -> null. */
export function parseCommand(text) {
  const m = /^\/([^\s/]+)\s*([\s\S]*)$/.exec((text || "").trim());
  if (!m) return null;
  const cmd = ALIASES[m[1].toLowerCase()];
  return cmd ? { cmd, arg: m[2].trim() } : { cmd: "unknown", name: m[1], arg: m[2].trim() };
}

/** 'Name: text', '"Two Words" text' or 'Name text' -> { name, rest }. */
export function splitName(arg) {
  const s = (arg || "").trim();
  const m = /^"([^"]+)"\s*:?\s*([\s\S]*)$/.exec(s) || /^([^:\n]{1,60}?)\s*:\s*([\s\S]*)$/.exec(s);
  if (m) return { name: m[1].trim(), rest: m[2].trim() };
  const [name = "", ...rest] = s.split(/\s+/);
  return { name, rest: rest.join(" ").trim() };
}
