export type ClosingTransitionEvent = {
  readonly data: { readonly closing: boolean };
};

export type DismissalNavigation = {
  addListener(
    event: 'transitionEnd',
    listener: (event: ClosingTransitionEvent) => void,
  ): () => void;
};

/** Runs a handoff after the uncovered native-stack route finishes appearing. */
export function handoffAfterAppearance(
  navigation: DismissalNavigation,
  onAppeared: () => void,
): () => void {
  let completed = false;
  const unsubscribe = navigation.addListener('transitionEnd', (event) => {
    if (event.data.closing || completed) return;
    completed = true;
    unsubscribe();
    onAppeared();
  });
  return unsubscribe;
}
