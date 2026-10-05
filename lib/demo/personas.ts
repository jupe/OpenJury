/** Fictional demo accounts. The viewer switches between them to try every role. */
export type Persona = { id: string; email: string; name: string; description: string };

export const personas: Persona[] = [
  { id: "00000000-0000-4000-8000-000000000001", email: "alex@demo.openjury.app", name: "Alex Rivera", description: "Northside Makers admin" },
  { id: "00000000-0000-4000-8000-000000000002", email: "sam@demo.openjury.app", name: "Sam Lee", description: "Member, Riverside Choir admin" },
  { id: "00000000-0000-4000-8000-000000000003", email: "robin@demo.openjury.app", name: "Robin Park", description: "Member" },
  { id: "00000000-0000-4000-8000-000000000004", email: "kai@demo.openjury.app", name: "Kai Moreno", description: "Member" },
  { id: "00000000-0000-4000-8000-000000000005", email: "pat@demo.openjury.app", name: "Pat Quinn", description: "Platform admin" },
];

export const [alex, sam, robin, kai, pat] = personas;
