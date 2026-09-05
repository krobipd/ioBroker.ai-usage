// this file used only for simulation and not used in end build
import React from "react";
import { ThemeProvider, StyledEngineProvider } from "@mui/material/styles";
import { Box } from "@mui/material";

import { GenericApp, I18n, Loader, type GenericAppProps, type GenericAppState } from "@iobroker/gui-components";

import ConfigPanel from "./ConfigPanel";
import { supportedLanguage } from "./rows";

import enLocal from "./i18n/en.json";
import deLocal from "./i18n/de.json";
import ruLocal from "./i18n/ru.json";
import ptLocal from "./i18n/pt.json";
import nlLocal from "./i18n/nl.json";
import frLocal from "./i18n/fr.json";
import itLocal from "./i18n/it.json";
import esLocal from "./i18n/es.json";
import plLocal from "./i18n/pl.json";
import ukLocal from "./i18n/uk.json";
import zhCNLocal from "./i18n/zh-cn.json";

interface AppState extends GenericAppState {
  data: Record<string, unknown>;
  originalData: Record<string, unknown>;
}

class App extends GenericApp<GenericAppProps, AppState> {
  constructor(props: GenericAppProps) {
    super(props, { ...props });
    this.state = {
      ...this.state,
      data: { accounts: [] },
      originalData: { accounts: [] },
      theme: this.createTheme(),
    };
    const translations = {
      en: enLocal,
      de: deLocal,
      ru: ruLocal,
      pt: ptLocal,
      nl: nlLocal,
      fr: frLocal,
      it: itLocal,
      es: esLocal,
      pl: plLocal,
      uk: ukLocal,
      "zh-cn": zhCNLocal,
    };
    for (const [lang, dict] of Object.entries(translations)) {
      I18n.extendTranslations(dict, lang as ioBroker.Languages);
    }
    I18n.setLanguage(supportedLanguage(navigator.language));
  }

  render(): React.JSX.Element {
    if (!this.state.loaded) {
      return (
        <StyledEngineProvider injectFirst>
          <ThemeProvider theme={this.state.theme}>
            <Loader themeType={this.state.themeType} />
          </ThemeProvider>
        </StyledEngineProvider>
      );
    }

    return (
      <StyledEngineProvider injectFirst>
        <ThemeProvider theme={this.state.theme}>
          <Box sx={{ height: "100%", bgcolor: "background.default", color: "text.primary" }}>
            <div style={{ padding: 50, width: 760 }}>
              <ConfigPanel
                oContext={{
                  adapterName: "ai-usage",
                  socket: this.socket,
                  instance: 0,
                  themeType: this.state.theme.palette.mode,
                  isFloatComma: true,
                  dateFormat: "",
                  forceUpdate: () => {},
                  systemConfig: {} as ioBroker.SystemConfigCommon,
                  theme: this.state.theme,
                  _themeName: this.state.themeName,
                  onCommandRunning: () => {},
                }}
                alive
                changed={false}
                themeName={this.state.theme.palette.mode}
                common={{} as ioBroker.InstanceCommon}
                attr="_accounts"
                data={this.state.data}
                originalData={this.state.originalData}
                onError={() => {}}
                schema={{
                  url: "custom/customComponents.js",
                  i18n: true,
                  name: "AiUsageComponentSet/Components/ConfigPanel",
                  type: "custom",
                }}
                onChange={data => this.setState({ data: data as Record<string, unknown> })}
              />
            </div>
          </Box>
        </ThemeProvider>
      </StyledEngineProvider>
    );
  }
}

export default App;
