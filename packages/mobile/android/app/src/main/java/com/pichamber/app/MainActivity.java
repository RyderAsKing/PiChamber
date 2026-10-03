package com.pichamber.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PiChamberFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
