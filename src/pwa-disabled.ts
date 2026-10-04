// Desktop installs update the bundled frontend; browser service workers must
// never cache or replace that bundle.
export function registerSW() { return async (_reload?: boolean) => {}; }
