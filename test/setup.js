// three's SVGLoader parses with DOMParser, which Node doesn't ship.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
