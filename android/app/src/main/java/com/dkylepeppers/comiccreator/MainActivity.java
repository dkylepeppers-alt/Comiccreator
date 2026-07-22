package com.dkylepeppers.comiccreator;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalReferenceClassifierPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
