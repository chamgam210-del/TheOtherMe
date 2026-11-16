/** Scripts and questions used by the guided recordings and questionnaire. */

export interface VoicePrompt {
  id: string;
  kind: "reading" | "story";
  title: string;
  text: string;
  /** Rough length when read or answered at a relaxed pace. */
  targetSec: number;
}

export const READINGS: VoicePrompt[] = [
  {
    id: "read-01", kind: "reading", title: "A morning outdoors", targetSec: 75,
    text: "The morning started quietly. A thin mist hung over the valley, and the first light slid across the hills like warm honey. I laced up my boots, filled a bottle with cold water, and followed the narrow path past the old stone wall. Somewhere above me a bird was testing its song. By the time I reached the ridge the mist had burned away, and the whole town lay below, small and bright and perfectly still. I sat down, took a long breath, and let myself notice how good it felt to have nowhere else to be. Then I ate an apple, listened a little longer, and started the walk home.",
  },
  {
    id: "read-02", kind: "reading", title: "In the kitchen", targetSec: 70,
    text: "Start by heating a little oil in a wide pan. Add chopped onions and a pinch of salt, and let them soften slowly, stirring now and then. When the kitchen begins to smell sweet, add two cloves of garlic, a spoonful of tomato paste, and a handful of fresh basil. Pour in the tomatoes, crush them gently with the back of a spoon, and let everything simmer for twenty minutes. Taste it. Does it need more salt, or maybe a splash of lemon? Adjust until it tastes like something you would be proud to put on the table, and then call everyone in before it gets cold.",
  },
  {
    id: "read-03", kind: "reading", title: "Travel day", targetSec: 75,
    text: "Our flight was delayed twice, so we ended up eating dinner at gate fourteen, which, to be fair, had surprisingly good noodles. When we finally landed, it was past midnight, and the city was glowing orange under a light rain. The taxi driver recommended a tiny place near the harbor that stays open all night, and he was right. We shared a table with two strangers, traded stories about lost luggage and wrong turns, and laughed until the owner started stacking chairs. It was not the trip we planned. It was better, in the way that unplanned things sometimes are.",
  },
  {
    id: "read-04", kind: "reading", title: "Numbers and dates", targetSec: 60,
    text: "The meeting is on Thursday, the twelfth of March, at a quarter past ten. Please bring forty-two copies of the report, three hundred and sixteen pages in total, and remember that the budget was revised from two point five million to just over three million dollars. The office is on the seventh floor of 1850 Maple Avenue, room 704. If you are running late, call 555-0147 and ask for extension 392. We expect about sixty people, so arrive early, and keep in mind that parking closes at six in the evening.",
  },
  {
    id: "read-05", kind: "reading", title: "A bit of history", targetSec: 70,
    text: "Long before there were highways, merchants crossed the mountains by following narrow trails worn smooth by centuries of travelers. They carried salt, cloth, spices, and news, and every village along the route had its own customs and its own opinion of strangers. Over time, small markets grew into towns, and towns grew into cities, each one shaped by the roads that fed it. When you walk through an old market square today, you are standing where countless conversations once happened, where prices were argued, friendships began, and plans were made for journeys that nobody could be sure would end well.",
  },
  {
    id: "read-06", kind: "reading", title: "Questions and answers", targetSec: 55,
    text: "Do you remember the first time we met? I think it was raining. Or was that the second time? Honestly, I can never keep those two straight. What I do remember is that you were laughing at something, and I wanted to know what it was. So I asked, and you said it was nothing, and then you told me anyway. Isn't that funny? You never seem to say what you mean right away, but you always get there in the end. And somehow that is exactly why I like talking with you.",
  },
  {
    id: "read-07", kind: "reading", title: "How things work", targetSec: 65,
    text: "A good habit is simple, small, and repeatable. Instead of promising yourself an hour of exercise every day, begin with ten minutes. Put your shoes by the door, choose a time that already exists in your routine, and keep it boring on purpose. The goal in the first month is not progress; it is showing up. Once showing up feels normal, you can add a little more. Most people fail because they start too big and quit too early, not because they lack discipline. Make it easy, make it small, and let time do the heavy lifting.",
  },
  {
    id: "read-08", kind: "reading", title: "Warm words", targetSec: 60,
    text: "I wanted to say thank you. Not just for the help last week, although that mattered more than you know, but for the way you always make people feel like they belong. You notice the quiet ones, you remember the small details, and you never make anyone feel like a bother. It is a rare gift. I hope you know how much it is appreciated, and I hope somebody tells you so as often as you tell everyone else. Anyway, that is all. Take care of yourself, and call me soon.",
  },
  {
    id: "read-09", kind: "reading", title: "A story with a twist", targetSec: 75,
    text: "The old lighthouse keeper had a rule: never open the red door at the top of the stairs. For forty years he followed it. Then one stormy night, a knock came from the other side. Slowly, heart pounding, he turned the key. Behind the door was nothing but a small round room, a table, and a single cup of tea, still steaming. On the saucer lay a note that said, in his own handwriting, thank you for waiting. He laughed so hard he had to sit down, and nobody ever learned what the joke was, least of all the sea.",
  },
  {
    id: "read-10", kind: "reading", title: "Everyday talk", targetSec: 60,
    text: "Okay, so here is the plan. We grab coffee first, because I am not a person before coffee. Then we swing by the market, pick up whatever looks good, and head to the park if the weather holds. If it rains, we will do the museum instead; they have that exhibit you wanted to see. Either way, let's be back by six. Sound good? Great. Oh, and bring a jacket, just in case. You know how quickly the wind picks up near the water, and I would rather not hear about it for the rest of the evening.",
  },
];

export const STORIES: VoicePrompt[] = [
  { id: "story-01", kind: "story", title: "Where you grew up", text: "Tell me about the place you grew up. What did the street look like, what did it smell and sound like, and what did you do after school?", targetSec: 120 },
  { id: "story-02", kind: "story", title: "Family at home", text: "Describe your family around the dinner table when you were a kid. Who sat where, who talked the most, and what did people argue or laugh about?", targetSec: 120 },
  { id: "story-03", kind: "story", title: "A proud moment", text: "What is something you are really proud of? Walk me through how it happened and how it felt.", targetSec: 120 },
  { id: "story-04", kind: "story", title: "A mistake that taught you something", text: "Tell me about a mistake you made that you ended up learning a lot from.", targetSec: 120 },
  { id: "story-05", kind: "story", title: "Your best friend", text: "Tell me about a close friend: how you met, what you do together, and an inside joke only the two of you understand.", targetSec: 120 },
  { id: "story-06", kind: "story", title: "What you do", text: "Explain your work, or what fills your days, to someone who has no idea what it involves. What do you enjoy and what drives you crazy?", targetSec: 120 },
  { id: "story-07", kind: "story", title: "A perfect day", text: "Describe your ideal day from the moment you wake up until you go to sleep. Be specific about food, places, and people.", targetSec: 120 },
  { id: "story-08", kind: "story", title: "Something that makes you laugh", text: "What makes you laugh out loud? Tell me about the funniest thing that has happened to you recently, or ever.", targetSec: 120 },
  { id: "story-09", kind: "story", title: "Advice you give", text: "What advice do you find yourself giving people again and again? Why do you believe it?", targetSec: 120 },
  { id: "story-10", kind: "story", title: "A hard time", text: "Talk about a difficult time and how you got through it. Share only what you are comfortable having your AI self say.", targetSec: 120 },
  { id: "story-11", kind: "story", title: "Your favorites", text: "Tell me about your favorite food, music, movies, and places, and explain why you love them.", targetSec: 120 },
  { id: "story-12", kind: "story", title: "Traditions and holidays", text: "How do you celebrate holidays and birthdays? Describe a tradition that matters to you and where it came from.", targetSec: 120 },
  { id: "story-13", kind: "story", title: "What you believe", text: "What do you care about most in life, and what do you think matters less than people assume?", targetSec: 120 },
  { id: "story-14", kind: "story", title: "A message to the people you love", text: "Imagine talking to the people closest to you. What would you want them to know about you, and what would you say to cheer them up on a bad day?", targetSec: 120 },
];

export const VOICE_PROMPTS: VoicePrompt[] = [...READINGS, ...STORIES];

export const VOICE_PLAN_SECONDS = VOICE_PROMPTS.reduce((n, p) => n + p.targetSec, 0);

export const VIDEO_SCRIPT = [
  "Hi, I'm recording this video so my AI version can look like me. I'll talk naturally and look straight at the camera lens.",
  "A little about my day: I woke up, made coffee, and checked the weather. It's one of those days where I can't decide whether to stay in or go for a walk, so I'll probably do a bit of both.",
  "When I talk to people I like to smile, nod, and use my hands a little. I'll try to be myself, not stiff, and not too dramatic either.",
  "Let me tell you about something I enjoy. I love spending time with the people I care about: sharing food, telling stories, and laughing at the same old jokes.",
  "Now I'll pause for a moment and think. Hmm. What else? I'll look slightly to the side, then back at the camera, the way I would in a real conversation.",
  "Here's a question I might ask a friend: how has your week been? Good, I hope. Mine has been busy, but in a good way.",
  "Okay. I'll slow down and speak clearly for a moment. The quick brown fox jumps over the lazy dog, and the five boxing wizards jump quickly.",
  "I'll finish with a warm goodbye. It was really great talking with you. Take care, and talk to you soon.",
].join("\n\n");

export const CONSENT_TEMPLATE = (name: string) =>
  `I, ${name.trim()}, am currently speaking and give consent to Tavus to create an AI clone of me by using the audio and video samples I'm providing. I understand that this AI clone can be used to create videos that look and sound like me.`;

export const AVOID_SUGGESTIONS = [
  "politics", "religion", "my health", "money and finances", "my ex", "someone who passed away", "my job troubles", "family conflicts", "legal matters", "my age", "weight and dieting",
];

export interface Question {
  id: string;
  label: string;
  hint: string;
  required?: boolean;
  rows?: number;
}

export const QUESTIONNAIRE: Question[] = [
  { id: "nickname", label: "What do people call you?", hint: "Nicknames, short names, what family calls you." },
  { id: "hometown", label: "Where did you grow up?", hint: "Towns, countries, anything that shaped you.", required: true },
  { id: "work", label: "What do you do for work or with your days?", hint: "Jobs, studies, what you are known for.", required: true },
  { id: "personality", label: "Describe yourself in a few words", hint: "How would your friends describe you?", required: true, rows: 3 },
  { id: "humor", label: "What is your sense of humor like?", hint: "Dry, silly, sarcastic? What makes you laugh?", rows: 3 },
  { id: "values", label: "What matters most to you?", hint: "Values, causes, what you would never compromise.", rows: 3 },
  { id: "hobbies", label: "How do you spend free time?", hint: "Hobbies, sports, routines, places you love.", rows: 3 },
  { id: "favorites", label: "Favorite foods, music, shows, teams", hint: "The things you would happily talk about for an hour.", rows: 3 },
  { id: "greeting", label: "How do you greet and sign off with people?", hint: "Catchphrases, pet names, how you talk to family versus friends.", rows: 3 },
  { id: "stories", label: "Stories you often tell", hint: "Milestones and anecdotes people ask you to retell.", rows: 4 },
];

/** Builds the "about you" paragraph the persona uses, from the questionnaire. */
export function composeBasics(name: string, answers: Record<string, string>): string {
  const line = (label: string, id: string) => {
    const v = (answers[id] ?? "").trim();
    return v ? `${label}: ${v}` : null;
  };
  const nick = (answers.nickname ?? "").trim();
  return [
    nick ? `My name is ${name} (people call me ${nick}).` : `My name is ${name}.`,
    line("Where I grew up", "hometown"),
    line("What I do", "work"),
    line("How I'd describe myself", "personality"),
    line("My sense of humor", "humor"),
    line("What matters to me", "values"),
    line("What I do in my free time", "hobbies"),
    line("Some of my favorites", "favorites"),
    line("How I greet and sign off with people", "greeting"),
    line("Stories I like to tell", "stories"),
  ]
    .filter(Boolean)
    .join("\n");
}

export interface AccountGuide {
  id: "tavus" | "elevenlabs" | "deepgram" | "llm";
  name: string;
  purpose: string;
  signupUrl: string;
  keyUrl: string;
  steps: string[];
  cost: string;
  note?: string;
}

export const ACCOUNT_GUIDES: AccountGuide[] = [
  {
    id: "tavus", name: "Tavus", purpose: "Your live video face (the AI replica) and the video call.",
    signupUrl: "https://platform.tavus.io", keyUrl: "https://platform.tavus.io/api-keys",
    steps: ["Create a Tavus account and choose a plan that includes personal replicas.", "Open API Keys in the Tavus dashboard and create a new key.", "Copy the key and paste it below."],
    cost: "Paid plan; replica creation and call minutes are billed by Tavus.",
  },
  {
    id: "elevenlabs", name: "ElevenLabs", purpose: "Your cloned voice.",
    signupUrl: "https://elevenlabs.io/sign-up", keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    steps: ["Create an ElevenLabs account and subscribe to a plan that includes Professional Voice Cloning (Creator or higher).", "Open Settings, then API Keys, and create a key with access to voices and text to speech.", "Copy the key and paste it below."],
    cost: "Paid plan with Professional Voice Cloning.",
    note: "You will verify your voice with ElevenLabs once later; the app walks you through it.",
  },
  {
    id: "deepgram", name: "Deepgram", purpose: "Turns your recordings into text so the AI can learn how you talk.",
    signupUrl: "https://console.deepgram.com/signup", keyUrl: "https://console.deepgram.com/",
    steps: ["Create a Deepgram account (it includes free starting credit).", "In the console choose API Keys, then Create a New API Key.", "Copy the key and paste it below."],
    cost: "Pay as you go; transcribing 30 minutes costs a few cents.",
  },
  {
    id: "llm", name: "AI model provider", purpose: "The \"brain\" that writes your replies.",
    signupUrl: "https://platform.openai.com/signup", keyUrl: "https://platform.openai.com/api-keys",
    steps: ["Create an OpenAI account (or another provider with an OpenAI-compatible API) and add a small amount of credit.", "Open API keys and create a new secret key.", "Copy the key and paste it below. Keep the default address and model unless you use another provider."],
    cost: "Pay as you go; typical conversation costs are small.",
  },
];

/** Where the one-click server deploy starts. Fork owners can change this to their own repo. */
export const DEPLOY_URL = "https://render.com/deploy?repo=https://github.com/chamgam210-del/TheOtherMe";
