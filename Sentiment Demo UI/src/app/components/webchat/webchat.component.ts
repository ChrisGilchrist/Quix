import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
} from "@angular/core";
import { FormControl, FormGroup } from "@angular/forms";
import { ActivatedRoute } from "@angular/router";
import {
  NgxQrcodeElementTypes,
  NgxQrcodeErrorCorrectionLevels,
} from "@techiediaries/ngx-qrcode";
import {
  Chart,
  ChartDataset,
  ChartOptions,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
} from "chart.js";
import "chartjs-adapter-luxon";
import ChartStreaming, { RealTimeScale } from "chartjs-plugin-streaming";
import {
  Subject,
  Subscription,
  debounceTime,
  takeUntil,
  timer,
} from "rxjs";
import { MessagePayload } from "src/app/models/messagePayload";
import { ParameterData } from "src/app/models/parameterData";
import { ConnectionState, QuixService } from "../../services/quix.service";
import { TitleCasePipe } from "@angular/common";

@Component({
  selector: "app-webchat",
  templateUrl: "./webchat.component.html",
  styleUrls: ["./webchat.component.scss"],
  providers: [TitleCasePipe],
})
export class WebchatComponent implements OnInit, OnDestroy {
  @ViewChild("chatWrapper") chatWrapper: ElementRef<HTMLElement>;
  @ViewChild("myChart") myChart: Chart;

  connectionState = ConnectionState;
  readerConnectionStatus: ConnectionState = ConnectionState.Offline;
  writerConnectionStatus: ConnectionState = ConnectionState.Offline;

  ngxQrcodeElementTypes = NgxQrcodeElementTypes;
  ngxQrcodeErrorCorrectionLevels = NgxQrcodeErrorCorrectionLevels;
  qrValue: string;

  messages: MessagePayload[] = [];

  usersTyping: Map<string, Subscription> = new Map();
  typingTimeout: number = 4000;
  typingDebounce: number = 300;
  messageSent: boolean = false;

  room: string;
  name: string;
  phone: string;
  email: string;

  messageFC = new FormControl("");
  chatForm = new FormGroup({
    message: this.messageFC,
  });

  datasets: ChartDataset[] = [
    {
      data: [],
      label: "Chatroom sentiment",
      borderColor: "#0064ff",
      backgroundColor: "rgba(0, 100, 255, 0.24)",
      pointBackgroundColor: "white",
      pointBorderColor: "black",
      pointBorderWidth: 2,
      fill: true,
    },
  ];

  options: ChartOptions = {
    interaction: {
      mode: "index",
      intersect: false,
    },
    maintainAspectRatio: false,
    animation: false,
    scales: {
      y: {
        type: "linear",
        max: 1,
        min: -1,
      },
      x: {
        type: "realtime",
        realtime: {
          duration: 20000,
          refresh: 1000,
          delay: 200,
          onRefresh: (chart: Chart) => {},
        },
      },
    },
    plugins: {
      legend: {
        display: false,
      },
    },
  };

  private unsubscribe$ = new Subject<void>();

  constructor(
    private quixService: QuixService,
    private route: ActivatedRoute,
    private titleCasePipe: TitleCasePipe
  ) {
    Chart.register(
      LinearScale,
      LineController,
      PointElement,
      LineElement,
      RealTimeScale,
      Legend,
      ChartStreaming
    );
  }

  public send() {
    this.sendMessage(false);
    this.messageFC.reset("", { emitEvent: false });
  }

  ngOnInit() {
    this.init();

    this.messageFC.valueChanges.pipe(debounceTime(300), takeUntil(this.unsubscribe$)).subscribe(() => {
      this.sendMessage(true);
    });

    // Listen for connection status changes
    this.quixService.readerConnectionStatusChanged$.subscribe((status) => {
      this.readerConnectionStatus = status;
      if (status === ConnectionState.Connected) this.connect();
    });
    this.quixService.writerConnectionStatusChanged$.subscribe(
      (status) => (this.writerConnectionStatus = status)
    );

    // Listen for reader messages
    this.quixService.readerParamDataRecieved$.pipe(takeUntil(this.unsubscribe$)).subscribe((payload) => {
      // console.log("Component - Payload Recieved", x);
      this.messageReceived(payload);
    });
  }

  init() {
    const paramMap = this.route.snapshot.paramMap;
    this.room = paramMap.get("room") || "";
    this.name = paramMap.get("name") || "";
    this.phone = paramMap.get("phone") || "";
    this.email = paramMap.get("email") || "";
  }

  messageReceived(payload: ParameterData): void {
    console.log("Receiving parameter data - ", payload);

    let topicId = payload.topicId;
    // debugger;
    let [timestamp] = payload.timestamps;
    let [name] = payload.tagValues["name"];
    let sentiment = payload.numericValues["sentiment"]?.at(0) || 0;
    let averageSentiment =
      payload.numericValues["average_sentiment"]?.at(0) || 0;
    let message = this.messages.find(
      (f) => f.timestamp === timestamp && f.name === name
    );

    if (topicId === this.quixService.messagesDraftTopic) {
      const timer$ = timer(3000); // Emits after 3 seconds

      // If they were already tying
      if (this.usersTyping.get(name)) {
        this.usersTyping.get(name)?.unsubscribe();
      }
      // When it finishes, removes the user from typing list
      const subscription = timer$.subscribe(() => {
        this.usersTyping.delete(name);
        // console.log("Clearing user from map", this.usersTyping);
      });
      this.usersTyping.set(name, subscription);
    }

    // console.log("USERS TYPING", this.usersTyping);
    if (topicId === this.quixService.messagesTopic) {
      // If its in the typing map then remove it
      const userTyping = this.usersTyping.get(name);
      if (userTyping) {
        userTyping.unsubscribe();
        this.usersTyping.delete(name);
        //console.log('REMOVING IT', name);
      }

      // Now handle the message sent
      if (!message) {
        this.messages.push({
          timestamp,
          name,
          sentiment,
          value: payload.stringValues["chat-message"][0],
        });
      } else {
        message.sentiment = sentiment;
        message.value = payload.stringValues["chat-message"][0];
      }
    }

    if (averageSentiment) {
      let row = { x: timestamp / 1000000, y: averageSentiment };
      this.datasets[0].data.push(row as any);
    }

    const el = this.chatWrapper.nativeElement;
    const isScrollToBottom = el.offsetHeight + el.scrollTop >= el.scrollHeight;

    if (isScrollToBottom) setTimeout(() => (el.scrollTop = el.scrollHeight));
  }

  sendMessage(isDraft: boolean): void {
    const message: string = this.messageFC.value || "";
    this.quixService.sendMessage(
      this.room,
      "Customer",
      this.name,
      message,
      isDraft,
      this.phone,
      this.email
    );
  }

  /**
   * Util Method to generate the isTyping message based on the users that
   * are currently typing in the chat.
   * @returns
   */
  getTypingMessage(): string | undefined {
    const users = Array.from(this.usersTyping.keys())
      //.filter((f) => f !== this.name)
      .map((userName) => this.titleCasePipe.transform(userName));
    if (users.length === 1) return `${users[0]} is Typing...`;
    else if (users.length > 1) {
      const lastUser = users.pop();
      return `${users.join(", ")} and ${lastUser} are typing...`;
    } else return undefined;
  }

  getDateFromTimestamp(timestamp: number) {
    return new Date(timestamp / 1000000);
  }

  connect() {
    this.quixService.subscribeToParameter(
      this.quixService.messagesTopic,
      this.room,
      "chat-message"
    );
    this.quixService.subscribeToParameter(
      this.quixService.messagesDraftTopic,
      this.room,
      "chat-message"
    );
    this.quixService.subscribeToParameter(
      this.quixService.sentimentTopic,
      this.room,
      "sentiment"
    );
    this.quixService.subscribeToParameter(
      this.quixService.sentimentTopic,
      this.room,
      "chat-message"
    );
    this.quixService.subscribeToParameter(
      this.quixService.sentimentTopic,
      this.room,
      "average_sentiment"
    );

    let host = window.location.host;
    this.qrValue = `${window.location.protocol}//${host}/lobby?room=${this.room}`;

    this.quixService.getLastMessages(this.room).subscribe((lastMessage) => {
      console.log("LAST MESSAGES", lastMessage);
      this.messages = lastMessage.slice(
        Math.max(0, lastMessage.length - 20),
        lastMessage.length
      );

      const el = this.chatWrapper.nativeElement;
      setTimeout(() => (el.scrollTop = el.scrollHeight));
    });
  }

  ngOnDestroy(): void {
    // Unsubscribe from all the parameters
    this.quixService.unsubscribeFromParameter(this.quixService.messagesTopic,this.room,"chat-message");
    this.quixService.unsubscribeFromParameter(this.quixService.messagesDraftTopic,this.room,"chat-message");
    this.quixService.unsubscribeFromParameter(this.quixService.sentimentTopic,this.room,"sentiment");
    this.quixService.unsubscribeFromParameter(this.quixService.sentimentTopic,this.room,"chat-message");
    this.quixService.unsubscribeFromParameter(this.quixService.sentimentTopic, this.room, "average_sentiment");

    this.unsubscribe$.next();
    this.unsubscribe$.complete();
  }
}
