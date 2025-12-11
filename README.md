# Telegram Poll Bot with Vote Limits(WIP)

A custom Telegram bot that creates polls with configurable vote limits per option — a feature not available in native Telegram polls.

## Features

- Create polls with custom vote limits for each option
- Visual progress bars showing current votes vs. limits
- Automatic blocking when an option reaches its limit
- Vote retraction — users can change their vote
- Displays voter names for each option
- Poll creator can close voting at any time

## Usage

| Command | Description |
|---------|-------------|
| `/newpoll` | Start creating a new poll |
| `/done` | Finish poll creation |
| `/cancel` | Cancel poll creation |
| `/closepoll` | Close the active poll |
| `/help` | Show help message |

### Creating a Poll

1. Send `/newpoll`
2. Enter your poll question
3. Add options in format: `Option text | limit`
4. Send `/done` when finished

**Example:**
```
/newpoll
Volleyball tomorrow! 🏐 We are capping it at 3 teams (18 players). First come, first served!
I'm in! (Claim a spot) 🙋‍♂️ | 18
Can't make it 😢 | 100 
/done
```
