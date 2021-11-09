import java.net.InetAddress;
public class Main {
	public static void main(String[] argv) throws Exception {
		InetAddress addr = InetAddress.getByName("172.18.18.35");
		System.out.println("Host name is: "+addr.getHostName());
		System.out.println("Ip address is: "+ addr.getHostAddress());
	}
}