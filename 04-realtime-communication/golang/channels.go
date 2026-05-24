package main

// ChannelAdapter is the interface every channel (CLI, Web, QQ …) must implement.
type ChannelAdapter interface {
	name() string
	onMessage(handler func(ACPMessage))
	send(reply AgentReply)
	start() error
}
