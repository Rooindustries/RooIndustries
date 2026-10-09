const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "click"];
const LISTENER_OPTIONS = { capture: true, passive: true };
let interactionPromise = null;

export const whenUserInteracts = () => {
  if (typeof window === "undefined") return new Promise(() => {});
  if (!interactionPromise) {
    interactionPromise = new Promise((resolve) => {
      const handleInteraction = () => {
        INTERACTION_EVENTS.forEach((type) =>
          window.removeEventListener(type, handleInteraction, LISTENER_OPTIONS)
        );
        resolve();
      };
      INTERACTION_EVENTS.forEach((type) =>
        window.addEventListener(type, handleInteraction, LISTENER_OPTIONS)
      );
    });
  }
  return interactionPromise;
};
