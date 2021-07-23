package wbrules

import (
	"github.com/wirenboard/wbgong/testutils"
	"testing"
)

type RuleLoopbackSuite struct {
	RuleSuiteBase
}

func (s *RuleLoopbackSuite) SetupTest() {
	s.RuleSuiteBase.SetupSkippingDefs("testrules_loopback.js")
}

func (s *RuleLoopbackSuite) TestSetGaugeLoud() {
	s.publish("/devices/loopback/controls/set_loud/on", "1", "loopback/set_loud", "loopback/gauge")
	s.VerifyUnordered(
		"tst -> /devices/loopback/controls/set_loud/on: [1] (QoS 1)",
		"driver -> /devices/loopback/controls/set_loud: [1] (QoS 1)", // note there's no 'retained' flag
		"[info] set_loud button pressed",
		"driver -> /devices/loopback/controls/gauge: [42] (QoS 1, retained)",
		"[info] gauge set to 42",
	)
}

func (s *RuleLoopbackSuite) TestSetGaugeSilent() {
	s.publish("/devices/loopback/controls/set_silent/on", "1", "loopback/set_silent") // no event for loopback/gauge here
	s.VerifyUnordered(
		"tst -> /devices/loopback/controls/set_silent/on: [1] (QoS 1)",
		"driver -> /devices/loopback/controls/set_silent: [1] (QoS 1)", // note there's no 'retained' flag
		"[info] set_silent button pressed",
		"driver -> /devices/loopback/controls/gauge: [84] (QoS 1, retained)",
	)
	s.VerifyEmpty() // no log entry from gauge rule
}

func TestRuleLoopbackSuite(t *testing.T) {
	testutils.RunSuites(t,
		new(RuleLoopbackSuite),
	)
}
