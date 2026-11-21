export function verifyPlacement(query: {
  readonly home: string;
  readonly service: string;
  readonly skill: string;
  readonly harness: string;
}): { readonly state: "placed" | "changed" | "absent"; readonly reason: string };
