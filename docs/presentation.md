# Public presentation contract

How the public page decides what to show, in what order, and what sits behind it. It covers steps 61 to 78 of the reconstruction plan and governs Release 1 onward. Nothing here changes the live page yet; R1 builds to it.

## The governing test [61]

Every element on a public page earns its place by helping a person understand their surroundings or decide what to do. An element that only shows how the system works belongs in reference, however accurate it is.

## Four tiers [62]

| Tier | What it is | Where it lives |
|---|---|---|
| Primary | what a visitor came for: what is happening, what changed, where, and what it means for them | the page itself, visible without a click |
| Contextual | why the primary picture is what it is | next to the conclusion it explains, short |
| Supporting | the evidence behind a conclusion | one disclosure away from that conclusion |
| Reference | how the system works and how to get the data | its own pages, linked, never inline |

## What goes where [63 to 73]

**Primary.**

- Current environmental conditions: air, heat, wind, visibility, active hazards [63].
- Important developments: anything that changed or started recently and matters, such as a new alert or a sharp drop in air quality [64].
- Geographic exploration: the map, and choosing a place to look at [65].
- Everyday activity assessments: whether conditions suit walking, running, cycling, being outdoors with children and similar activities [66].
- Park comparisons: which parks are likely busier, quieter or cooler [67].
- Historical changes and trajectories: how a condition has moved over hours, days and seasons [68].

**Contextual.** Explanations of how conditions relate, such as smoke arriving on a southwest wind or heat building over impervious ground [69].

**Supporting.** Individual observations, such as one station's reading or one alert's full text [70], and source availability and provenance, such as which sources fed a conclusion, how fresh each is and which are missing [71].

**Reference.** Inference mechanics and methodology [72], and raw data and API access [73].

## Navigation [74, 77]

- The home page holds primary information for the visitor's area and links to the map, history and parks views, each of which is also primary.
- Each primary view links down to its own supporting detail and across to the other primary views. Contextual notes ride along with the conclusions they explain.
- Reference has stable addresses of its own: a methods page, a sources page and an API page. Each is reachable from every page's footer and linkable on its own, so a reader can go straight to it without passing through the public views [77].
- Reference never links back into the page as if it were the main path. A visitor who never opens reference still gets a complete answer.

## Disclosure [75, 76]

Supporting information stays one tap or click away by default. It becomes visible at once, next to the conclusion, whenever it changes what the conclusion means [76]. That is the case when:

1. A source the conclusion depends on is missing, failing or older than its validity window.
2. The conclusion is modeled rather than observed, or has never been checked against observations (Crowd-Cast today).
3. Sources disagree on something the conclusion rests on.
4. Confidence or coverage is low enough that a reasonable person would act differently knowing it.
5. The visitor's location is outside the area the data covers.
6. The conclusion carries health or safety advice.

In those cases the qualification is shown in plain words with the conclusion, not as a footnote, and the full evidence stays behind its usual disclosure.

## The interpretation layer [78]

Computation (sources, collation, latents, the park model) stays as it is: it produces numbers with units, times and provenance. A separate public interpretation layer turns those into what the page says: bands, plain statements, activity guidance and the qualifications above.

- The page reads only from the interpretation layer, never from latents or snapshots directly.
- The interpretation layer may not change a computed value. It may only classify, word and qualify it.
- Every public statement records which computed values it came from, so supporting detail can show them.
- Wording that carries health or exposure advice comes from a registry with its source cited (Foundation PR F6) and is reviewed before release.

The evidence and public-field contract (F5) and the content and guidance registries (F6) define this layer's types and wording.
