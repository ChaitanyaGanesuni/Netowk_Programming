import java.util.*;
import java.rmi.*;
import java.rmi.registry.LocateRegistry;
import java.rmi.registry.Registry;
import java.rmi.server.UnicastRemoteObject;

public class RMIServer extends UnicastRemoteObject implements RMIClient  {

	
	 RMIServer() throws RemoteException{
		 super();
	 }

	
	
	public static void main(String[] args) throws RemoteException, AlreadyBoundException {
    
	   Registry reg=LocateRegistry.createRegistry(5014);
	   
	   System.out.println("Server is waiting for Client");
		
       reg.bind("add",new  RMIServer());

	}



	@Override
	public int add(int n1, int n2) throws RemoteException {
		
		return n1+n2;
	}

}