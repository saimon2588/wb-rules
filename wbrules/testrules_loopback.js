defineVirtualDevice("loopback", {
    cells: {
        gauge: {
            type: "value",
            value: 0
        },
        set_loud: {
            type: "pushbutton"
        },
        set_silent: {
            type: "pushbutton"
        }
    }
});

defineRule({
    whenChanged: "loopback/gauge",
    then: function(newValue) {
        log("gauge set to " + newValue);
    }
});

defineRule({
    whenChanged: "loopback/set_loud",
    then: function() {
        log("set_loud button pressed");
        dev["loopback/gauge"] = 42;
    }
});

defineRule({
    whenChanged: "loopback/set_silent",
    then: function() {
        log("set_silent button pressed");
        dev["loopback/gauge~"] = 84;
    }
});
