import { setWorldConstructor } from "@cucumber/cucumber";
import { RemoteCustomUiPage } from "./pages/remote-custom-ui-page.js";

class AcceptanceWorld {
  constructor() {
    this.remoteCustomUiPage = new RemoteCustomUiPage();
    this.scenarioName = undefined;
  }
}

setWorldConstructor(AcceptanceWorld);
