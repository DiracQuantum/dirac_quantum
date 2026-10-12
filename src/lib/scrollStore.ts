// Mutable scroll state shared between the DOM (Lenis) and the three.js scene.
// Read inside animation frames; never used to trigger React renders.
export const scrollState = {
  progress: 0,
  velocity: 0,
  sceneT: 0,
  /** 0 while a scene section is on screen, rises to 1 once the page scrolls past the last one (footer). */
  tail: 0,
  /** page-load burst progress 0..1 and how white-hot the particles currently are */
  intro: 0,
  introHot: 0,
};
